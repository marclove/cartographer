import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SSEStreamingApi } from 'hono/streaming';
import type { BehaviorTree } from '../core/behavior-tree.js';
import type { StateStore } from '../state/state-store.js';
import type { ActorMessage } from '../actor/types.js';
import type { ProcessResult } from '../actor/tree-actor.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';
import { InProcessEventStream } from './event-stream.js';
import { serializeTree, serializeNodeRef } from './serializers.js';
import { serializeTree as serializeTreeState } from '../core/serialization.js';
import { blackboardToRecord } from './blackboard-utils.js';
import { AgentNode } from '../nodes/agent.js';
import type { BTreeNode } from '../types.js';

const STATE_KEY = 'default';

interface StatusState {
  tickCount: number;
  cycleCount: number;
  lastStatus: string | null;
  lastDurationMs: number | null;
  startedAt: number;
}

function findNodeById(root: BTreeNode, id: string): BTreeNode | undefined {
  const stack: BTreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === id) return node;
    for (const child of node.children) stack.push(child);
  }
  return undefined;
}

export interface CartographerAppOptions {
  createTree: () => BehaviorTree;
  stateStore?: StateStore;
  context?: Record<string, unknown>;
  topologyPolicy?: 'fail' | 'reset';
  maxQueueDepth?: number;
}

export interface QueuedResult {
  queued: true;
  messageId: string;
  position: number;
}

export interface CartographerHandle {
  app: Hono;
  processMessage: (msg: ActorMessage) => Promise<ProcessResult | QueuedResult | null>;
  bridgeTree: (tree: BehaviorTree) => void;
  initializeState: () => Promise<void>;
  drainQueue: () => Promise<void>;
  closeSseClients: () => void;
}

export function createCartographerApp(options: CartographerAppOptions): CartographerHandle {
  const createTreeFn = options.createTree;
  const stateStore = options.stateStore ?? new InMemoryStateStore();
  const context = options.context ?? {};
  const eventStream = new InProcessEventStream(500);
  const stats: StatusState = { tickCount: 0, cycleCount: 0, lastStatus: null, lastDurationMs: null, startedAt: 0 };
  const sseClients = new Set<SSEStreamingApi>();

  function forwardEvent(event: { type: string; data: Record<string, unknown> }): void {
    trackEvent(event);
    eventStream.push(event.type, event.data);
  }

  function trackEvent(event: { type: string; data: Record<string, unknown> }): void {
    if (event.type === 'tree:tick') {
      stats.tickCount++;
      stats.lastStatus = event.data.status as string;
      stats.lastDurationMs = event.data.durationMs as number;
      if (event.data.status !== 'running') {
        stats.cycleCount++;
      }
    }
  }

  let _readTree: BehaviorTree | null = null;
  function readTree(): BehaviorTree {
    if (!_readTree) _readTree = createTreeFn();
    return _readTree;
  }

  const app = new Hono();

  // Global error handler
  app.onError((err, c) => {
    return c.json({ error: err.message, status: 500 }, 500);
  });

  // Read-only routes
  app.get('/_platform/health', (c) => {
    return c.json({ status: 'ok', uptime: Math.floor((Date.now() - stats.startedAt) / 1000) });
  });

  app.get('/api/status', (c) => {
    const tree = readTree();
    return c.json({
      tree: tree.name,
      tickCount: stats.tickCount,
      cycleCount: stats.cycleCount,
      lastStatus: stats.lastStatus,
      lastDurationMs: stats.lastDurationMs,
      uptime: Date.now() - stats.startedAt,
    });
  });

  app.get('/api/tree', (c) => {
    const tree = readTree();
    return c.json({ tree: tree.name, root: serializeTree(tree.root) });
  });

  app.get('/api/blackboard', async (c) => {
    const state = await stateStore.getState(STATE_KEY);
    return c.json(state?.blackboard ?? {});
  });

  app.get('/api/nodes/:id', (c) => {
    const tree = readTree();
    const nodeId = c.req.param('id');
    const node = findNodeById(tree.root, nodeId);
    if (!node) {
      return c.json({ error: 'Not found', status: 404 }, 404);
    }
    const base = serializeNodeRef(node);
    const detail: Record<string, unknown> = { ...base };
    if (node instanceof AgentNode) {
      const info = node.agentOptions;
      if (info.model) detail.model = info.model;
      detail.tools = info.tools ?? [];
      detail.mcpServers = (info.mcpServers as string[]) ?? [];
    }
    if (node.children.length > 0) {
      detail.children = node.children.map(serializeNodeRef);
    }
    return c.json(detail);
  });

  // SSE streaming
  app.get('/events', async (c) => {
    const tree = readTree();
    const state = await stateStore.getState(STATE_KEY);
    const snapshot = {
      tree: serializeTree(tree.root),
      blackboard: state?.blackboard ?? {},
      stats: { ...stats, asOfEventId: eventStream.latestId },
    };

    return streamSSE(c, async (stream) => {
      // 1. Send snapshot
      await stream.writeSSE({
        event: 'snapshot',
        data: JSON.stringify(snapshot),
        id: '0',
      });

      // 2. Replay missed events
      const lastId = c.req.header('Last-Event-ID');
      const sinceId = lastId ?? '0'; // always replay on connect for cartographer
      const missed = eventStream.replaySince(sinceId);
      if (missed === null) {
        // Buffer gap — resend snapshot
        await stream.writeSSE({
          event: 'snapshot',
          data: JSON.stringify(snapshot),
          id: '0',
        });
      } else {
        for (const entry of missed) {
          await stream.writeSSE({
            event: entry.event,
            data: JSON.stringify(entry.data),
            id: entry.id,
          });
        }
      }

      // 3. Subscribe to live events via serial write queue
      let writePromise = Promise.resolve();
      const unsubscribe = eventStream.subscribe((entry) => {
        writePromise = writePromise
          .then(() =>
            stream.writeSSE({
              event: entry.event,
              data: JSON.stringify(entry.data),
              id: entry.id,
            }),
          )
          .catch(() => {});
      });

      // 4. Keep alive until client disconnects
      stream.onAbort(() => {
        unsubscribe();
        sseClients.delete(stream);
      });
      sseClients.add(stream);

      // Block until aborted
      await new Promise(() => {});
    });
  });

  // Lifecycle
  async function initializeState() {
    stats.startedAt = Date.now();
    const existing = await stateStore.getState(STATE_KEY);
    if (!existing) {
      const tree = createTreeFn();
      _readTree = tree;
      for (const [key, value] of Object.entries(context)) {
        tree.blackboard.set(`context:${key}`, value);
      }
      const bb = blackboardToRecord(tree.blackboard);
      const treeState = serializeTreeState(tree.root, tree.rootHash);
      await stateStore.saveState(STATE_KEY, {
        blackboard: bb,
        treeState,
        treeStructure: serializeTree(tree.root),
        createdAt: Date.now(),
        lastMessageAt: Date.now(),
      });
    }
  }

  // Stubs for methods implemented in later tasks
  async function processMessage(_msg: ActorMessage): Promise<ProcessResult | QueuedResult | null> {
    throw new Error('Not yet implemented — see task 106');
  }
  function bridgeTree(_tree: BehaviorTree): void {
    // Implemented in task 107
  }
  async function drainQueue(): Promise<void> {
    // Implemented in task 106
  }
  function closeSseClients(): void {
    for (const client of sseClients) {
      client.close();
    }
    sseClients.clear();
  }

  return { app, processMessage, bridgeTree, initializeState, drainQueue, closeSseClients };
}
