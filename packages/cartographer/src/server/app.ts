import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SSEStreamingApi } from 'hono/streaming';
import type { BehaviorTree } from '../core/behavior-tree.js';
import type { StateStore } from '../state/state-store.js';
import type { ActorMessage } from '../actor/types.js';
import type { ProcessResult } from '../actor/message-processor.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';
import { InProcessEventStream } from './event-stream.js';
import { serializeTree, serializeNodeRef, serializeEvent } from './serializers.js';
import { serializeTree as serializeTreeState } from '../core/serialization.js';
import { blackboardToRecord } from './blackboard-utils.js';
import { AgentNode } from '../nodes/agent.js';
import type { BTreeNode } from '../types.js';
import { MessageProcessor } from '../actor/message-processor.js';
import { EventBridge } from './event-bridge.js';

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

export interface AppOptions {
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

export interface AppHandle {
  app: Hono;
  stateStore: StateStore;
  topologyPolicy: 'fail' | 'reset';
  maxQueueDepth: number;
  processMessage: (msg: ActorMessage) => Promise<ProcessResult | QueuedResult | null>;
  bridgeTree: (tree: BehaviorTree) => void;
  initializeState: () => Promise<void>;
  drainQueue: () => Promise<void>;
  closeSseClients: () => void;
}

export function createApp(options: AppOptions): AppHandle {
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

  const topologyPolicy = options.topologyPolicy ?? 'fail';
  const maxQueueDepth = options.maxQueueDepth ?? parseInt(process.env.CARTOGRAPHER_MAX_QUEUE_DEPTH ?? '16', 10);
  let activeActor: MessageProcessor | null = null;
  let activeMessageId: string | null = null;

  function generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function createBridge(messageId?: string): EventBridge {
    return new EventBridge(stateStore, STATE_KEY, messageId, (event) => forwardEvent(event));
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

  app.notFound((c) => {
    return c.json({ error: 'Not found', status: 404 }, 404);
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

  // POST routes
  app.post('/api/messages', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !body.type) {
      return c.json({ error: 'Missing message type', status: 400 }, 400);
    }
    if (body.type === 'command' && !body.name) {
      return c.json({ error: 'Command message requires name', status: 400 }, 400);
    }
    const msg: ActorMessage = { ...body };
    const prep = await acquireOrQueue(msg, body.id);
    if (prep.queued) {
      return prep.queueFull
        ? c.json({ error: 'Queue full', status: 429 }, 429)
        : c.json({ id: prep.bridge.messageId, status: 'queued', position: prep.position }, 202);
    }
    const response = c.json({ id: prep.bridge.messageId, status: 'processing' }, 202);
    executeMessage(msg, prep.requestId, prep.bridge).catch(() => {});
    return response;
  });

  app.post('/api/commands/:name', async (c) => {
    const name = c.req.param('name');
    const payload = await c.req.json().catch(() => null);
    const msg: ActorMessage = { type: 'command', name, payload };
    const prep = await acquireOrQueue(msg);
    if (prep.queued) {
      return prep.queueFull
        ? c.json({ error: 'Queue full', status: 429 }, 429)
        : c.json({ id: prep.bridge.messageId, status: 'queued', position: prep.position }, 202);
    }
    const response = c.json({ id: prep.bridge.messageId, status: 'processing' }, 202);
    executeMessage(msg, prep.requestId, prep.bridge).catch(() => {});
    return response;
  });

  app.post('/api/blackboard/:key', async (c) => {
    const key = c.req.param('key');
    const body = await c.req.json().catch(() => null);
    const value = body?.value;
    const msg: ActorMessage = { type: 'write', key, value };
    const prep = await acquireOrQueue(msg);
    if (prep.queued) {
      return prep.queueFull
        ? c.json({ error: 'Queue full', status: 429 }, 429)
        : c.json({ id: prep.bridge.messageId, status: 'queued', position: prep.position }, 202);
    }
    const response = c.json({ id: prep.bridge.messageId, status: 'processing' }, 202);
    executeMessage(msg, prep.requestId, prep.bridge).catch(() => {});
    return response;
  });

  app.post('/api/interrupt', (c) => {
    if (activeActor) {
      const messageId = activeMessageId;
      activeActor.requestInterrupt();
      return c.json({ interrupted: true, messageId });
    }
    return c.json({ interrupted: false });
  });

  app.post('/api/resume', async (c) => {
    const resumed = await stateStore.clearHeld(STATE_KEY);
    return c.json({ resumed });
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

  // Message processing core
  async function acquireOrQueue(
    msg: ActorMessage,
    messageId?: string,
  ): Promise<
    | { queued: false; requestId: string; bridge: EventBridge }
    | { queued: true; bridge: EventBridge; position: number; queueFull: false }
    | { queued: true; bridge: EventBridge; position: number; queueFull: true }
  > {
    const requestId = generateRequestId();
    const acquired = await stateStore.acquireLock(STATE_KEY, requestId, 30000);
    const bridge = createBridge(messageId);
    msg.id = bridge.messageId;
    if (acquired) return { queued: false, requestId, bridge };
    try {
      const { position } = await stateStore.enqueueMessage(STATE_KEY, msg, maxQueueDepth);
      await bridge.emitQueued(position);
      return { queued: true, bridge, position, queueFull: false };
    } catch {
      return { queued: true, bridge, position: -1, queueFull: true };
    }
  }

  async function executeMessage(
    msg: ActorMessage,
    requestId: string,
    bridge: EventBridge,
  ): Promise<ProcessResult> {
    const heartbeat = setInterval(async () => {
      try { await stateStore.renewLock(STATE_KEY, requestId, 30000); } catch {}
    }, 10000);

    try {
      const actor = new MessageProcessor({
        createTree: createTreeFn,
        stateStore,
        stateKey: STATE_KEY,
        topologyPolicy,
        eventBridge: bridge,
      });
      activeActor = actor;
      activeMessageId = bridge.messageId;
      const result = await actor.process(msg);
      if (result.interrupted) await bridge.emitInterrupted();
      await bridge.emitProcessed(String(result.treeStatus));
      return result;
    } catch (error) {
      await bridge.emitFailed(error instanceof Error ? error.message : String(error));
      return { treeStatus: 'error', error: error instanceof Error ? error.message : String(error) };
    } finally {
      activeActor = null;
      activeMessageId = null;
      clearInterval(heartbeat);
      await stateStore.releaseLock(STATE_KEY, requestId);
      drainQueue().catch(() => {});
    }
  }

  async function processMessage(msg: ActorMessage): Promise<ProcessResult | QueuedResult | null> {
    const prep = await acquireOrQueue(msg, msg.id);
    if (prep.queued) return prep.queueFull ? null : { queued: true, messageId: prep.bridge.messageId, position: prep.position };
    return executeMessage(msg, prep.requestId, prep.bridge);
  }

  async function drainQueue(): Promise<void> {
    const requestId = generateRequestId();
    const acquired = await stateStore.acquireLock(STATE_KEY, requestId, 30000);
    if (!acquired) return;
    const msg = await stateStore.dequeueMessage(STATE_KEY);
    if (!msg) {
      await stateStore.releaseLock(STATE_KEY, requestId);
      return;
    }
    const bridge = createBridge(msg.id);
    msg.id = bridge.messageId;
    await bridge.emitDequeued();
    executeMessage(msg, requestId, bridge).catch(() => {});
  }

  function bridgeTree(tree: BehaviorTree): void {
    tree.events.onAny((type, data) => {
      const serialized = serializeEvent(type as any, data as any);
      forwardEvent({ type, data: serialized });
    });
  }
  function closeSseClients(): void {
    for (const client of sseClients) {
      client.close();
    }
    sseClients.clear();
  }

  return { app, stateStore, topologyPolicy, maxQueueDepth, processMessage, bridgeTree, initializeState, drainQueue, closeSseClients };
}
