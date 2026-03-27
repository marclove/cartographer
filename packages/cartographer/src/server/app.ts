import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import type { BehaviorTree } from '../core/behavior-tree.js';
import type { StateStore } from '../state/state-store.js';
import type { ActorMessage } from '../actor/types.js';
import type { ProcessResult } from '../actor/message-processor.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';
import { serializeTree, serializeNodeRef } from './serializers.js';
import { AgentNode } from '../nodes/agent.js';
import type { BTreeNode } from '../types.js';
import { EventBridge } from './event-bridge.js';
import { createSessionStreams } from './session-streams.js';
import { createMessagePipeline } from './message-pipeline.js';
import type { QueuedResult } from './message-pipeline.js';

export type { QueuedResult } from './message-pipeline.js';

/** Accumulated tick/cycle statistics exposed via `GET /api/status`. */
interface StatusState {
  tickCount: number;
  cycleCount: number;
  lastStatus: string | null;
  lastDurationMs: number | null;
  startedAt: number;
}

/** Depth-first search for a node by its unique ID within a tree. */
function findNodeById(root: BTreeNode, id: string): BTreeNode | undefined {
  const stack: BTreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === id) return node;
    for (const child of node.children) stack.push(child);
  }
  return undefined;
}

/**
 * Configuration for {@link createApp}.
 *
 * Only `createTree` and `sessionId` are required. Everything else has sensible
 * defaults suitable for single-process, in-memory development.
 */
export interface AppOptions {
  /** Factory that produces a fresh {@link BehaviorTree} instance. Called once per message processing cycle. */
  createTree: () => BehaviorTree;
  /**
   * Persistence backend for tree state, locks, events, and the message queue.
   * Defaults to an {@link InMemoryStateStore} when omitted.
   */
  stateStore?: StateStore;
  /**
   * Key-value pairs written to the blackboard before the first tick of each
   * session. Useful for injecting configuration or credentials that every
   * tree execution needs.
   */
  context?: Record<string, unknown>;
  /**
   * What to do when the persisted node state no longer matches the tree structure
   * (e.g. after a code deploy changes the tree).
   *
   * - `'fail'` (default) — reject the message with an error.
   * - `'reset'` — silently discard stale node state and start fresh.
   */
  topologyPolicy?: 'fail' | 'reset';
  /**
   * Maximum number of messages that can be queued while one is being processed.
   * When the queue is full, new messages receive a 429 response.
   * Defaults to the `CARTOGRAPHER_MAX_QUEUE_DEPTH` env var, or `16`.
   */
  maxQueueDepth?: number;
  /**
   * Session key — a static string for single-session deployments, or a resolver
   * function that extracts the key from each incoming Hono request context
   * (e.g. from an auth token or header).
   *
   * Routes that require a session (`/events`, `/api/messages`, `/api/blackboard`, etc.)
   * return 401 when the resolver returns a falsy value.
   */
  sessionId: string | ((c: any) => string | Promise<string>);
  /**
   * How long (in ms) to keep an idle session's in-memory event stream
   * after the last SSE client disconnects. Evicts unused replay buffers
   * to bound memory.
   * Default: 300_000 (5 minutes). Set to 0 to disable eviction.
   */
  streamEvictionMs?: number;
}

/**
 * The object returned by {@link createApp}. Provides both the Hono application
 * (for HTTP serving) and programmatic methods for message processing and
 * lifecycle management.
 *
 * For most deployments, call {@link start} once and let the HTTP routes drive
 * processing. Use {@link processMessage} when you need to inject messages
 * programmatically from within the same process (e.g. from a test harness or
 * an embedding application).
 */
export interface AppHandle {
  /** The Hono application instance. Mount via `app.fetch` or pass to a Node.js HTTP server. */
  app: Hono;
  /** The persistence backend in use (either the one provided in options or the default in-memory store). */
  stateStore: StateStore;
  /** The active topology policy. See {@link AppOptions.topologyPolicy}. */
  topologyPolicy: 'fail' | 'reset';
  /** The active queue depth limit. See {@link AppOptions.maxQueueDepth}. */
  maxQueueDepth: number;
  /**
   * Process a message programmatically without going through the REST API.
   * Acquires the session lock (or queues) just like an HTTP request would.
   *
   * @returns The tree's {@link ProcessResult} on success, a {@link QueuedResult}
   *   if the message was queued behind an in-flight message, or `null` if the
   *   queue is full.
   */
  processMessage: (msg: ActorMessage, sessionKey: string) => Promise<ProcessResult | QueuedResult | null>;
  /** Resets the stats clock. Called automatically by {@link start}. */
  initializeState: () => Promise<void>;
  /** Attempts to process the next queued message for the given session. */
  drainQueue: (sessionKey: string) => Promise<void>;
  /** Closes every active SSE connection and clears all in-memory event streams. */
  closeSseClients: () => Promise<void>;
  /** Returns a Node.js HTTP request listener for mounting into Express, Fastify, or `http.createServer`. */
  nodeHandler: () => ReturnType<typeof getRequestListener>;
  /** Initializes state and drains any queued messages that survived a restart. */
  start: () => Promise<void>;
  /** Closes all SSE clients and cancels pending eviction timers. Alias for {@link closeSseClients}. */
  stop: () => Promise<void>;
}

/**
 * Creates a Hono-based HTTP application that exposes a behavior tree as a
 * REST + SSE API with session-scoped message processing and state persistence.
 *
 * This is the composition root for the server module. It wires together:
 * - **Session streams** — per-session SSE event buffers with TTL-based eviction
 * - **Message pipeline** — lock-based serial message processing with queuing
 * - **HTTP routes** — REST endpoints for tree inspection, message submission,
 *   interrupt/resume, and real-time SSE streaming
 *
 * The returned {@link AppHandle} can be served directly via `@hono/node-server`,
 * mounted into an existing server via {@link AppHandle.nodeHandler}, or wrapped
 * by {@link ActorServer} for a batteries-included standalone deployment.
 *
 * @example
 * ```ts
 * import { createApp } from 'cartographer';
 * import { serve } from '@hono/node-server';
 *
 * const handle = createApp({
 *   createTree: () => myTree,
 *   sessionId: 'default',
 * });
 *
 * await handle.start();
 * serve({ fetch: handle.app.fetch, port: 3148 });
 * ```
 */
export function createApp(options: AppOptions): AppHandle {
  const resolveSession: (c: any) => string | Promise<string> =
    typeof options.sessionId === 'string'
      ? () => options.sessionId as string
      : options.sessionId;

  const createTreeFn = options.createTree;
  const stateStore = options.stateStore ?? new InMemoryStateStore();
  const context = options.context ?? {};
  const streamEvictionMs = options.streamEvictionMs ?? 300_000;
  const topologyPolicy = options.topologyPolicy ?? 'fail';
  const maxQueueDepth = options.maxQueueDepth ?? parseInt(process.env.CARTOGRAPHER_MAX_QUEUE_DEPTH ?? '16', 10);
  const stats: StatusState = { tickCount: 0, cycleCount: 0, lastStatus: null, lastDurationMs: null, startedAt: 0 };

  const streams = createSessionStreams({ streamEvictionMs });

  /** Updates tick/cycle counters from `tree:tick` events for the `/api/status` endpoint. */
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

  /** Wires an {@link EventBridge} so events flow to both the stats tracker and the session's SSE stream. */
  function createBridge(sessionKey: string, messageId?: string): EventBridge {
    return new EventBridge(stateStore, sessionKey, messageId, (event) => {
      trackEvent(event);
      const stream = streams.getOrCreateStream(sessionKey);
      stream.push(event.type, event.data);
    });
  }

  const pipeline = createMessagePipeline({
    createTree: createTreeFn,
    stateStore,
    topologyPolicy,
    maxQueueDepth,
    context,
    createBridge,
    scheduleStreamEviction: streams.scheduleStreamEviction,
  });

  /** Lazily instantiates and caches a single tree for read-only route handlers. */
  let _readTree: BehaviorTree | null = null;
  function readTree(): BehaviorTree {
    if (!_readTree) _readTree = createTreeFn();
    return _readTree;
  }

  /** Extracts the resolved session key that the middleware stored on the Hono context. */
  function sessionId(c: any): string {
    return c.get('sessionId') as string;
  }

  const app = new Hono();

  // Session resolution middleware
  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (path === '/_platform/health' || path === '/api/status' || path === '/api/tree' || path.startsWith('/api/nodes/')) {
      return next();
    }

    const sid = await resolveSession(c);
    if (!sid) {
      return c.json({ error: 'Unauthorized: session ID required', status: 401 }, 401);
    }

    (c as any).set('sessionId', sid);
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
    const sessionStream = streams.getOrCreateStream(sid);
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
      const clients = streams.getOrCreateClientSet(sid);
      clients.add(stream);

      stream.onAbort(() => {
        unsubscribe();
        clients.delete(stream);
        streams.cleanupClientSetIfEmpty(sid);
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
    const prep = await pipeline.acquireOrQueue(msg, sid, body.id);
    if (prep.queued) {
      return prep.queueFull
        ? c.json({ error: 'Queue full', status: 429 }, 429)
        : c.json({ id: prep.bridge.messageId, status: 'queued', position: prep.position }, 202);
    }
    const response = c.json({ id: prep.bridge.messageId, status: 'processing' }, 202);
    pipeline.executeMessage(msg, sid, prep.requestId, prep.bridge).catch(() => {});
    return response;
  });

  app.post('/api/commands/:name', async (c) => {
    const sid = sessionId(c);
    const name = c.req.param('name');
    const payload = await c.req.json().catch(() => null);
    const msg: ActorMessage = { type: 'command', name, payload };
    const prep = await pipeline.acquireOrQueue(msg, sid);
    if (prep.queued) {
      return prep.queueFull
        ? c.json({ error: 'Queue full', status: 429 }, 429)
        : c.json({ id: prep.bridge.messageId, status: 'queued', position: prep.position }, 202);
    }
    const response = c.json({ id: prep.bridge.messageId, status: 'processing' }, 202);
    pipeline.executeMessage(msg, sid, prep.requestId, prep.bridge).catch(() => {});
    return response;
  });

  app.post('/api/blackboard/:key', async (c) => {
    const sid = sessionId(c);
    const key = c.req.param('key');
    const body = await c.req.json().catch(() => null);
    const value = body?.value;
    const msg: ActorMessage = { type: 'write', key, value };
    const prep = await pipeline.acquireOrQueue(msg, sid);
    if (prep.queued) {
      return prep.queueFull
        ? c.json({ error: 'Queue full', status: 429 }, 429)
        : c.json({ id: prep.bridge.messageId, status: 'queued', position: prep.position }, 202);
    }
    const response = c.json({ id: prep.bridge.messageId, status: 'processing' }, 202);
    pipeline.executeMessage(msg, sid, prep.requestId, prep.bridge).catch(() => {});
    return response;
  });

  app.post('/api/interrupt', (c) => {
    const sid = sessionId(c);
    const active = pipeline.activeProcessors.get(sid);
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
  }

  function nodeHandler() {
    return getRequestListener(app.fetch);
  }

  async function start(): Promise<void> {
    await initializeState();
    const stateKeys = await stateStore.listKeys();
    const queuedKeys = await stateStore.listQueuedKeys();
    const allKeys = [...new Set([...stateKeys, ...queuedKeys])];
    for (const key of allKeys) {
      pipeline.drainQueue(key).catch(() => {});
    }
  }

  async function stop(): Promise<void> {
    await streams.closeSseClients();
  }

  return {
    app,
    stateStore,
    topologyPolicy,
    maxQueueDepth,
    processMessage: pipeline.processMessage,
    initializeState,
    drainQueue: pipeline.drainQueue,
    closeSseClients: streams.closeSseClients,
    nodeHandler,
    start,
    stop,
  };
}
