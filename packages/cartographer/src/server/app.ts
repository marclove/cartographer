import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
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
  autoTick?: { intervalMs: number };
  /**
   * Extract session ID from the Hono request context.
   * Default: reads `c.get('sessionId')`, falls back to `'default'`.
   */
  resolveSessionId?: (c: any) => string | Promise<string>;
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
  processMessage: (msg: ActorMessage, sessionKey: string) => Promise<ProcessResult | QueuedResult | null>;
  bridgeTree: (tree: BehaviorTree) => void;
  initializeState: () => Promise<void>;
  drainQueue: (sessionKey: string) => Promise<void>;
  closeSseClients: () => void;
  startAutoTick: () => void;
  stopAutoTick: () => void;
  /** Returns a Node.js HTTP request listener for mounting into Express, Fastify, or `http.createServer`. */
  nodeHandler: () => ReturnType<typeof getRequestListener>;
  /** Initializes state and drains any queued messages. Call `startAutoTick()` separately after your server is listening. */
  start: () => Promise<void>;
  /** Stops auto-tick and closes all SSE clients. */
  stop: () => void;
}

export function createApp(options: AppOptions): AppHandle {
  if (options.resolveSessionId && options.autoTick) {
    throw new Error(
      'autoTick and resolveSessionId cannot be used together. '
      + 'Multi-session mode is request-driven. Use external triggers '
      + '(cron, webhooks) to tick individual sessions.'
    );
  }

  const createTreeFn = options.createTree;
  const stateStore = options.stateStore ?? new InMemoryStateStore();
  const context = options.context ?? {};
  const sessionStreams = new Map<string, InProcessEventStream>();
  const sessionSseClients = new Map<string, Set<SSEStreamingApi>>();
  const stats: StatusState = { tickCount: 0, cycleCount: 0, lastStatus: null, lastDurationMs: null, startedAt: 0 };

  function getOrCreateStream(sessionKey: string): InProcessEventStream {
    let stream = sessionStreams.get(sessionKey);
    if (!stream) {
      stream = new InProcessEventStream(500);
      sessionStreams.set(sessionKey, stream);
    }
    return stream;
  }

  function removeClientSet(sessionKey: string): void {
    const clients = sessionSseClients.get(sessionKey);
    if (!clients || clients.size === 0) {
      sessionSseClients.delete(sessionKey);
      // Keep the stream alive — its ring buffer holds events for replay on reconnect
    }
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
  const activeProcessors = new Map<string, { actor: MessageProcessor; messageId: string }>();

  function generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function createBridge(sessionKey: string, messageId?: string): EventBridge {
    return new EventBridge(stateStore, sessionKey, messageId, (event) => {
      trackEvent(event);
      const stream = getOrCreateStream(sessionKey);
      stream.push(event.type, event.data);
    });
  }

  let _readTree: BehaviorTree | null = null;
  function readTree(): BehaviorTree {
    if (!_readTree) _readTree = createTreeFn();
    return _readTree;
  }

  function sessionId(c: any): string {
    return c.get('sessionId') as string;
  }

  const app = new Hono();

  // Session resolution middleware
  app.use('*', async (c, next) => {
    // Skip session resolution for session-independent endpoints
    const path = c.req.path;
    if (path === '/_platform/health' || path === '/api/status' || path === '/api/tree' || path.startsWith('/api/nodes/')) {
      return next();
    }

    const sessionId = options.resolveSessionId
      ? await options.resolveSessionId(c)
      : ((c as any).get('sessionId') as string | undefined) ?? 'default';

    if (!sessionId) {
      return c.json({ error: 'Unauthorized: session ID required', status: 401 }, 401);
    }

    (c as any).set('sessionId', sessionId);
    await next();
  });

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
    const sid = sessionId(c);
    const state = await stateStore.getState(sid);
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
    const sid = sessionId(c);
    const tree = readTree();
    const state = await stateStore.getState(sid);
    const sessionStream = getOrCreateStream(sid);
    const snapshot = {
      tree: serializeTree(tree.root),
      blackboard: state?.blackboard ?? {},
      stats: { ...stats, asOfEventId: sessionStream.latestId },
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
      const sinceId = lastId ?? '0';
      const missed = sessionStream.replaySince(sinceId);
      if (missed === null) {
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
      const unsubscribe = sessionStream.subscribe((entry) => {
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

      // 4. Track SSE client per session
      let clients = sessionSseClients.get(sid);
      if (!clients) {
        clients = new Set();
        sessionSseClients.set(sid, clients);
      }
      clients.add(stream);

      stream.onAbort(() => {
        unsubscribe();
        clients!.delete(stream);
        removeClientSet(sid);
      });

      // Block until aborted
      await new Promise(() => {});
    });
  });

  // POST routes
  app.post('/api/messages', async (c) => {
    const sid = sessionId(c);
    const body = await c.req.json().catch(() => null);
    if (!body || !body.type) {
      return c.json({ error: 'Missing message type', status: 400 }, 400);
    }
    if (body.type === 'command' && !body.name) {
      return c.json({ error: 'Command message requires name', status: 400 }, 400);
    }
    const msg: ActorMessage = { ...body };
    const prep = await acquireOrQueue(msg, sid, body.id);
    if (prep.queued) {
      return prep.queueFull
        ? c.json({ error: 'Queue full', status: 429 }, 429)
        : c.json({ id: prep.bridge.messageId, status: 'queued', position: prep.position }, 202);
    }
    const response = c.json({ id: prep.bridge.messageId, status: 'processing' }, 202);
    executeMessage(msg, sid, prep.requestId, prep.bridge).catch(() => {});
    return response;
  });

  app.post('/api/commands/:name', async (c) => {
    const sid = sessionId(c);
    const name = c.req.param('name');
    const payload = await c.req.json().catch(() => null);
    const msg: ActorMessage = { type: 'command', name, payload };
    const prep = await acquireOrQueue(msg, sid);
    if (prep.queued) {
      return prep.queueFull
        ? c.json({ error: 'Queue full', status: 429 }, 429)
        : c.json({ id: prep.bridge.messageId, status: 'queued', position: prep.position }, 202);
    }
    const response = c.json({ id: prep.bridge.messageId, status: 'processing' }, 202);
    executeMessage(msg, sid, prep.requestId, prep.bridge).catch(() => {});
    return response;
  });

  app.post('/api/blackboard/:key', async (c) => {
    const sid = sessionId(c);
    const key = c.req.param('key');
    const body = await c.req.json().catch(() => null);
    const value = body?.value;
    const msg: ActorMessage = { type: 'write', key, value };
    const prep = await acquireOrQueue(msg, sid);
    if (prep.queued) {
      return prep.queueFull
        ? c.json({ error: 'Queue full', status: 429 }, 429)
        : c.json({ id: prep.bridge.messageId, status: 'queued', position: prep.position }, 202);
    }
    const response = c.json({ id: prep.bridge.messageId, status: 'processing' }, 202);
    executeMessage(msg, sid, prep.requestId, prep.bridge).catch(() => {});
    return response;
  });

  app.post('/api/interrupt', (c) => {
    const sid = sessionId(c);
    const active = activeProcessors.get(sid);
    if (active) {
      active.actor.requestInterrupt();
      return c.json({ interrupted: true, messageId: active.messageId });
    }
    return c.json({ interrupted: false });
  });

  app.post('/api/resume', async (c) => {
    const sid = sessionId(c);
    const resumed = await stateStore.clearHeld(sid);
    return c.json({ resumed });
  });

  // Lifecycle
  async function initializeState() {
    stats.startedAt = Date.now();
    // Only eagerly initialize state in single-session mode
    if (options.resolveSessionId) return;

    const existing = await stateStore.getState('default');
    if (!existing) {
      const tree = createTreeFn();
      _readTree = tree;
      for (const [key, value] of Object.entries(context)) {
        tree.blackboard.set(`context:${key}`, value);
      }
      const bb = blackboardToRecord(tree.blackboard);
      const treeState = serializeTreeState(tree.root, tree.rootHash);
      await stateStore.saveState('default', {
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
    sessionKey: string,
    messageId?: string,
  ): Promise<
    | { queued: false; requestId: string; bridge: EventBridge }
    | { queued: true; bridge: EventBridge; position: number; queueFull: false }
    | { queued: true; bridge: EventBridge; position: number; queueFull: true }
  > {
    const requestId = generateRequestId();
    const acquired = await stateStore.acquireLock(sessionKey, requestId, 30000);
    const bridge = createBridge(sessionKey, messageId);
    msg.id = bridge.messageId;
    if (acquired) return { queued: false, requestId, bridge };
    try {
      const { position } = await stateStore.enqueueMessage(sessionKey, msg, maxQueueDepth);
      await bridge.emitQueued(position);
      return { queued: true, bridge, position, queueFull: false };
    } catch {
      return { queued: true, bridge, position: -1, queueFull: true };
    }
  }

  async function executeMessage(
    msg: ActorMessage,
    sessionKey: string,
    requestId: string,
    bridge: EventBridge,
  ): Promise<ProcessResult> {
    const heartbeat = setInterval(async () => {
      try { await stateStore.renewLock(sessionKey, requestId, 30000); } catch {}
    }, 10000);

    try {
      const actor = new MessageProcessor({
        createTree: createTreeFn,
        stateStore,
        stateKey: sessionKey,
        topologyPolicy,
        eventBridge: bridge,
        context,
      });
      activeProcessors.set(sessionKey, { actor, messageId: bridge.messageId });
      const result = await actor.process(msg);
      if (result.interrupted) await bridge.emitInterrupted();
      await bridge.emitProcessed(String(result.treeStatus));
      return result;
    } catch (error) {
      await bridge.emitFailed(error instanceof Error ? error.message : String(error));
      return { treeStatus: 'error', error: error instanceof Error ? error.message : String(error) };
    } finally {
      activeProcessors.delete(sessionKey);
      clearInterval(heartbeat);
      await stateStore.releaseLock(sessionKey, requestId);
      drainQueue(sessionKey).catch(() => {});
    }
  }

  async function processMessage(msg: ActorMessage, sessionKey: string): Promise<ProcessResult | QueuedResult | null> {
    const prep = await acquireOrQueue(msg, sessionKey, msg.id);
    if (prep.queued) return prep.queueFull ? null : { queued: true, messageId: prep.bridge.messageId, position: prep.position };
    return executeMessage(msg, sessionKey, prep.requestId, prep.bridge);
  }

  async function drainQueue(sessionKey: string): Promise<void> {
    const requestId = generateRequestId();
    const acquired = await stateStore.acquireLock(sessionKey, requestId, 30000);
    if (!acquired) return;
    const msg = await stateStore.dequeueMessage(sessionKey);
    if (!msg) {
      await stateStore.releaseLock(sessionKey, requestId);
      return;
    }
    const bridge = createBridge(sessionKey, msg.id);
    msg.id = bridge.messageId;
    await bridge.emitDequeued();
    executeMessage(msg, sessionKey, requestId, bridge).catch(() => {});
  }

  function bridgeTree(tree: BehaviorTree): void {
    tree.events.onAny((type, data) => {
      const serialized = serializeEvent(type as any, data as any);
      trackEvent({ type, data: serialized });
      const stream = sessionStreams.get('default');
      if (stream) {
        stream.push(type, serialized);
      }
    });
  }
  function closeSseClients(): void {
    for (const [, clients] of sessionSseClients) {
      for (const client of clients) {
        client.close();
      }
    }
    sessionSseClients.clear();
    sessionStreams.clear();
  }

  let autoTickTimer: ReturnType<typeof setInterval> | null = null;
  let autoTickInFlight = false;

  function startAutoTick(): void {
    if (!options.autoTick || autoTickTimer) return;
    autoTickTimer = setInterval(async () => {
      if (autoTickInFlight) return;
      autoTickInFlight = true;
      try {
        await processMessage({ type: 'tick' }, 'default');
      } catch {
        // Swallow transient errors (e.g. StateStore connection loss) so the
        // server stays alive and retries on the next interval.
      } finally {
        autoTickInFlight = false;
      }
    }, options.autoTick.intervalMs);
  }

  function stopAutoTick(): void {
    if (autoTickTimer) {
      clearInterval(autoTickTimer);
      autoTickTimer = null;
    }
  }

  function nodeHandler() {
    return getRequestListener(app.fetch);
  }

  async function start(): Promise<void> {
    await initializeState();
    if (options.resolveSessionId) {
      // Multi-session: drain queued messages for all known sessions
      const keys = await stateStore.listKeys();
      for (const key of keys) {
        drainQueue(key).catch(() => {});
      }
    } else {
      drainQueue('default').catch(() => {});
    }
  }

  function stop(): void {
    stopAutoTick();
    closeSseClients();
  }

  return { app, stateStore, topologyPolicy, maxQueueDepth, processMessage, bridgeTree, initializeState, drainQueue, closeSseClients, startAutoTick, stopAutoTick, nodeHandler, start, stop };
}
