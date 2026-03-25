import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { BehaviorTree } from '../core/behavior-tree.js';
import { serializeTree } from '../core/serialization.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';
import type { StateStore } from '../state/state-store.js';
import { TreeActor } from '../actor/tree-actor.js';
import type { ActorMessage } from '../actor/types.js';
import type { ProcessResult } from '../actor/tree-actor.js';
import { jsonResponse, jsonError, readBody } from './http-utils.js';
import { EventBridge } from './event-bridge.js';
import { InProcessEventStream, type EventStream } from './event-stream.js';
import { handleSseStream, blackboardToRecord } from './sse-handler.js';
import type { SseClient } from './sse-handler.js';
import { serializeTree as serializeTreeForApi, serializeEvent } from './serializers.js';
import { handleApiHealth, handleApiStatus, handleApiTree, handleApiNode } from './api-handlers.js';
import type { StatusState } from './api-handlers.js';
import { matchRoute } from './router.js';
import type { Route } from './router.js';

function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Configuration for creating an {@link ActorServer}.
 *
 * At minimum, you must provide a `createTree` factory. All other options have
 * sensible defaults suitable for local development.
 *
 * @example
 * ```ts
 * const server = new ActorServer({
 *   createTree: () => new BehaviorTree({ name: 'my-tree', root: myRoot }),
 *   port: 0,              // let the OS pick an available port
 *   context: { tenant: 'acme' },
 *   topologyPolicy: 'reset',
 * });
 * ```
 */
export interface ActorServerOptions {
  /** Factory that creates a fresh {@link BehaviorTree} instance for each message processed. */
  createTree: () => BehaviorTree;

  /**
   * Persistence backend for tree state, locks, events, and the message queue.
   * Defaults to an {@link InMemoryStateStore} (suitable for single-process / dev use).
   */
  stateStore?: StateStore;

  /**
   * TCP port to listen on. Defaults to the `PORT` environment variable, or `3148`
   * if unset. Pass `0` to let the OS assign an available port — the actual port
   * is returned by {@link ActorServer.start}.
   */
  port?: number;

  /**
   * Initial key-value pairs written to the blackboard under the `context:` namespace
   * when the server creates its first state snapshot. Useful for injecting
   * configuration (tenant IDs, API keys, feature flags) that nodes can read
   * during execution.
   */
  context?: Record<string, unknown>;

  /**
   * How the server reacts when the tree's topology (structure hash) has changed
   * between ticks — for example, after a code deploy.
   *
   * - `'fail'` (default) — reject the message with an error, preserving the
   *   existing state so an operator can investigate.
   * - `'reset'` — discard the stale state and re-initialize from the new tree
   *   definition, allowing processing to continue automatically.
   */
  topologyPolicy?: 'fail' | 'reset';

  /**
   * Maximum number of messages that can wait in the queue while another message
   * is being processed. When the queue is full, new messages are rejected with
   * HTTP 429 (via the REST API) or a `null` return (via {@link ActorServer.processMessage}).
   *
   * Defaults to the `CARTOGRAPHER_MAX_QUEUE_DEPTH` environment variable, or `16`.
   */
  maxQueueDepth?: number;
}

/**
 * Returned by {@link ActorServer.processMessage} when the server is already
 * processing another message and the incoming message has been placed in the
 * queue for later execution.
 */
export interface QueuedResult {
  /** Always `true` — discriminant for distinguishing from {@link ProcessResult}. */
  queued: true;
  /** Unique identifier assigned to the queued message. */
  messageId: string;
  /** 1-based position in the queue (1 = next to be processed). */
  position: number;
}

/**
 * HTTP server that wraps a {@link TreeActor} with a REST + SSE API.
 *
 * ActorServer provides a message-driven interface to a behavior tree. Clients
 * send messages (ticks, commands, blackboard writes) via HTTP POST and observe
 * tree activity in real time through a Server-Sent Events stream. Only one
 * message is processed at a time; additional messages are queued and drained
 * in order.
 *
 * For programmatic (non-HTTP) usage within the same process, call
 * {@link processMessage} directly instead of going through the REST API.
 *
 * ## REST API
 *
 * | Method | Path                      | Description                          |
 * |--------|---------------------------|--------------------------------------|
 * | GET    | `/_platform/health`       | Health check with uptime             |
 * | GET    | `/api/blackboard`         | Current blackboard snapshot          |
 * | GET    | `/api/status`             | Tick/cycle stats and tree name       |
 * | GET    | `/api/tree`               | Full serialized tree structure       |
 * | GET    | `/api/nodes/:id`          | Single node detail by ID             |
 * | GET    | `/events`                 | SSE event stream                     |
 * | POST   | `/api/messages`           | Submit an {@link ActorMessage}       |
 * | POST   | `/api/commands/:name`     | Shorthand for command messages       |
 * | POST   | `/api/blackboard/:key`    | Write a single blackboard key        |
 * | POST   | `/api/interrupt`          | Request interruption of active tick  |
 * | POST   | `/api/resume`             | Resume a held tree                   |
 *
 * ## SSE Event Stream
 *
 * Connecting to `GET /events` delivers:
 * 1. A `snapshot` event with the current tree structure, blackboard, and stats.
 * 2. Replayed events from the in-memory buffer (supports reconnection via
 *    the `Last-Event-ID` header).
 * 3. Live events as they occur (node ticks, agent activity, message lifecycle).
 *
 * @example
 * ```ts
 * const server = new ActorServer({
 *   createTree: () => new BehaviorTree({ name: 'hello', root }),
 *   port: 0,
 * });
 *
 * const { port } = await server.start();
 * console.log(`Listening on http://localhost:${port}`);
 *
 * // Send a tick via the REST API
 * await fetch(`http://localhost:${port}/api/messages`, {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ type: 'tick' }),
 * });
 *
 * // Or process a message programmatically
 * const result = await server.processMessage({ type: 'tick' });
 *
 * await server.stop();
 * ```
 */
export class ActorServer {
  private static readonly STATE_KEY = 'default';

  private readonly createTree: () => BehaviorTree;
  /** The persistence backend used for tree state, locks, events, and the message queue. */
  readonly stateStore: StateStore;
  private readonly configPort: number;
  private readonly context: Record<string, unknown>;
  /** How the server handles tree topology changes between ticks. See {@link ActorServerOptions.topologyPolicy}. */
  readonly topologyPolicy: 'fail' | 'reset';
  /** Maximum queued messages allowed while a message is being processed. See {@link ActorServerOptions.maxQueueDepth}. */
  readonly maxQueueDepth: number = 16;
  private server: Server | null = null;
  private activeActor: TreeActor | null = null;
  private activeMessageId: string | null = null;
  private readonly stats: StatusState = { tickCount: 0, cycleCount: 0, lastStatus: null, lastDurationMs: null, startedAt: 0 };
  private readonly eventStream: EventStream = new InProcessEventStream(500);
  private readonly sseClients: Set<SseClient> = new Set();
  private _readTree: BehaviorTree | null = null;
  private readonly routes: Route[];

  private createBridge(messageId?: string): EventBridge {
    return new EventBridge(this.stateStore, ActorServer.STATE_KEY, messageId, (event) => this.forwardEvent(event));
  }

  /** Returns a stable tree instance used for read-only introspection (consistent node IDs). */
  private get readTree(): BehaviorTree {
    if (!this._readTree) {
      this._readTree = this.createTree();
    }
    return this._readTree;
  }

  constructor(options: ActorServerOptions) {
    this.createTree = options.createTree;
    this.stateStore = options.stateStore ?? new InMemoryStateStore();
    this.configPort = options.port ?? parseInt(process.env.PORT ?? '3148', 10);
    this.context = options.context ?? {};
    this.topologyPolicy = options.topologyPolicy ?? 'fail';
    this.maxQueueDepth = options.maxQueueDepth ?? parseInt(process.env.CARTOGRAPHER_MAX_QUEUE_DEPTH ?? '16', 10);
    this.routes = [
      { method: 'GET',  pattern: '/_platform/health',     handler: (_req, res) => handleApiHealth(res, this.stats) },
      { method: 'GET',  pattern: '/api/blackboard',       handler: (_req, res) => this.handleBlackboardRead(res) },
      { method: 'GET',  pattern: '/api/status',           handler: (_req, res) => handleApiStatus(res, this.readTree, this.stats) },
      { method: 'GET',  pattern: '/api/tree',             handler: (_req, res) => handleApiTree(res, this.readTree) },
      { method: 'GET',  pattern: '/api/nodes/:id',        handler: (_req, res, p) => handleApiNode(res, this.readTree, p.id) },
      { method: 'GET',  pattern: '/events',               handler: (req, res) => this.handleSSE(req, res) },
      { method: 'POST', pattern: '/api/messages',         handler: (req, res) => this.handleMessage(req, res) },
      { method: 'POST', pattern: '/api/commands/:name',   handler: (req, res, p) => this.handleCommand(req, res, p.name) },
      { method: 'POST', pattern: '/api/blackboard/:key',  handler: (req, res, p) => this.handleBlackboardWrite(req, res, p.key) },
      { method: 'POST', pattern: '/api/interrupt',        handler: (_req, res) => this.handleInterrupt(res) },
      { method: 'POST', pattern: '/api/resume',           handler: (_req, res) => this.handleResume(res) },
    ];
  }

  /**
   * Initialize state (if needed) and start the HTTP server.
   *
   * On first call the server creates a default state snapshot in the
   * {@link stateStore} using the `createTree` factory and any `context` values
   * provided in {@link ActorServerOptions}. It also drains any messages that
   * were queued by a previous process (relevant when using a persistent store
   * like Redis).
   *
   * @returns The port the server is listening on. When the configured port is
   *          `0`, this is the OS-assigned port.
   * @throws  If the port is unavailable or another listen error occurs.
   */
  async start(): Promise<{ port: number }> {
    this.stats.startedAt = Date.now();

    const existing = await this.stateStore.getState(ActorServer.STATE_KEY);
    if (!existing) {
      await this.initializeDefaultState();
    }

    // Drain any queued messages from a previous process
    this.drainQueue().catch(() => {});

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          jsonError(res, 500, err instanceof Error ? err.message : 'Internal error');
        }
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.configPort, () => {
        this.server!.removeListener('error', reject);
        const addr = this.server!.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.configPort;
        resolve({ port: actualPort });
      });
    });
  }

  /**
   * Subscribe to a tree's events and forward them through the SSE pipeline.
   *
   * This is useful when a {@link TreeScheduler} manages tree execution externally
   * but you still want dashboard clients connected via `/events` to observe the
   * tree's activity in real time.
   *
   * @param tree - The tree whose events should be forwarded to SSE clients.
   */
  bridgeTree(tree: BehaviorTree): void {
    tree.events.onAny((type, data) => {
      const serialized = serializeEvent(type as any, data as any);
      this.forwardEvent({ type, data: serialized });
    });
  }

  /**
   * Gracefully shut down the server.
   *
   * Closes all active SSE connections first, then stops the HTTP server.
   * In-flight message processing is *not* cancelled — if you need to abort
   * an active tick, call the `/api/interrupt` endpoint before stopping.
   */
  async stop(): Promise<void> {
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private async initializeDefaultState(): Promise<void> {
    const tree = this.createTree();
    this._readTree = tree;
    for (const [key, value] of Object.entries(this.context)) {
      tree.blackboard.set(`context:${key}`, value);
    }
    const blackboard = blackboardToRecord(tree.blackboard);
    const treeState = serializeTree(tree.root, tree.rootHash);
    await this.stateStore.saveState(ActorServer.STATE_KEY, {
      blackboard,
      treeState,
      treeStructure: serializeTreeForApi(tree.root),
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = req.method ?? 'GET';

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchRoute(url.pathname, route.pattern);
      if (params) return route.handler(req, res, params);
    }

    jsonError(res, 404, 'Not found');
  }

  private async handleBlackboardRead(res: ServerResponse): Promise<void> {
    const state = await this.stateStore.getState(ActorServer.STATE_KEY);
    jsonResponse(res, 200, state?.blackboard ?? {});
  }

  private async handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (!body || !body.type) {
      return jsonError(res, 400, 'Missing message type');
    }
    if (body.type === 'command' && !body.name) {
      return jsonError(res, 400, 'Command message requires name');
    }
    await this.processAsync({ ...body }, res, body.id);
  }

  private async handleCommand(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const payload = await readBody(req);
    await this.processAsync({ type: 'command', name, payload }, res);
  }

  private async handleBlackboardWrite(req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
    const body = await readBody(req);
    const value = body?.value;
    await this.processAsync({ type: 'write', key, value }, res);
  }

  /**
   * Process a message programmatically without going through the REST API.
   *
   * This is the primary entry point for in-process callers (e.g., a
   * {@link TreeScheduler} or integration tests) that want to send messages
   * to the tree actor directly.
   *
   * Behavior mirrors the HTTP `POST /api/messages` endpoint:
   * - If no other message is being processed, the tree is ticked immediately
   *   and a {@link ProcessResult} is returned when complete.
   * - If a message is already in flight, the new message is placed in the
   *   queue and a {@link QueuedResult} is returned.
   * - If the queue is full, `null` is returned (equivalent to HTTP 429).
   *
   * @param msg - The message to process.
   * @returns The processing result, a queued confirmation, or `null` if the
   *          queue is full.
   */
  async processMessage(msg: ActorMessage): Promise<ProcessResult | QueuedResult | null> {
    const prep = await this.acquireOrQueue(msg, msg.id);
    if (prep.queued) return prep.queueFull ? null : { queued: true, messageId: prep.bridge.messageId, position: prep.position };
    return this.executeMessage(msg, prep.requestId, prep.bridge);
  }

  private async processAsync(msg: ActorMessage, res: ServerResponse, clientMessageId?: string): Promise<void> {
    const prep = await this.acquireOrQueue(msg, clientMessageId);
    if (prep.queued) {
      return prep.queueFull
        ? jsonError(res, 429, 'Queue full')
        : jsonResponse(res, 202, { id: prep.bridge.messageId, status: 'queued', position: prep.position });
    }
    jsonResponse(res, 202, { id: prep.bridge.messageId, status: 'processing' });
    this.executeMessage(msg, prep.requestId, prep.bridge).catch(() => {});
  }

  private async acquireOrQueue(
    msg: ActorMessage,
    messageId?: string,
  ): Promise<
    | { queued: false; requestId: string; bridge: EventBridge }
    | { queued: true; bridge: EventBridge; position: number; queueFull: false }
    | { queued: true; bridge: EventBridge; position: number; queueFull: true }
  > {
    const requestId = generateRequestId();
    const acquired = await this.stateStore.acquireLock(ActorServer.STATE_KEY, requestId, 30000);

    const bridge = this.createBridge(messageId);
    msg.id = bridge.messageId;

    if (acquired) return { queued: false, requestId, bridge };

    try {
      const { position } = await this.stateStore.enqueueMessage(ActorServer.STATE_KEY, msg, this.maxQueueDepth);
      await bridge.emitQueued(position);
      return { queued: true, bridge, position, queueFull: false };
    } catch {
      return { queued: true, bridge, position: -1, queueFull: true };
    }
  }

  private async executeMessage(
    msg: ActorMessage,
    requestId: string,
    bridge: EventBridge,
  ): Promise<ProcessResult> {
    const heartbeat = setInterval(async () => {
      try { await this.stateStore.acquireLock(ActorServer.STATE_KEY, requestId, 30000); } catch {}
    }, 10000);

    try {
      const actor = new TreeActor({
        createTree: this.createTree,
        stateStore: this.stateStore,
        stateKey: ActorServer.STATE_KEY,
        topologyPolicy: this.topologyPolicy,
        eventBridge: bridge,
      });
      this.activeActor = actor;
      this.activeMessageId = bridge.messageId;
      const result = await actor.process(msg);

      if (result.interrupted) {
        await bridge.emitInterrupted();
      }

      await bridge.emitProcessed(String(result.treeStatus));
      return result;
    } catch (error) {
      await bridge.emitFailed(error instanceof Error ? error.message : String(error));
      return { treeStatus: 'error', error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.activeActor = null;
      this.activeMessageId = null;
      clearInterval(heartbeat);
      await this.stateStore.releaseLock(ActorServer.STATE_KEY, requestId);
      this.drainQueue().catch(() => {});
    }
  }

  private async drainQueue(): Promise<void> {
    const requestId = generateRequestId();
    const acquired = await this.stateStore.acquireLock(ActorServer.STATE_KEY, requestId, 30000);
    if (!acquired) return; // Someone else is processing; they'll drain when done

    const msg = await this.stateStore.dequeueMessage(ActorServer.STATE_KEY);
    if (!msg) {
      await this.stateStore.releaseLock(ActorServer.STATE_KEY, requestId);
      return;
    }

    const bridge = this.createBridge(msg.id);
    msg.id = bridge.messageId;
    await bridge.emitDequeued();
    // executeMessage will call drainQueue again in its finally block
    this.executeMessage(msg, requestId, bridge).catch(() => {});
  }

  private handleInterrupt(res: ServerResponse): void {
    if (this.activeActor) {
      const messageId = this.activeMessageId;
      this.activeActor.requestInterrupt();
      jsonResponse(res, 200, { interrupted: true, messageId });
    } else {
      jsonResponse(res, 200, { interrupted: false });
    }
  }

  private async handleResume(res: ServerResponse): Promise<void> {
    const state = await this.stateStore.getState(ActorServer.STATE_KEY);
    if (state?.held) {
      await this.stateStore.saveState(ActorServer.STATE_KEY, { ...state, held: false });
      jsonResponse(res, 200, { resumed: true });
    } else {
      jsonResponse(res, 200, { resumed: false });
    }
  }

  private async handleSSE(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const tree = this.readTree;
    const state = await this.stateStore.getState(ActorServer.STATE_KEY);
    const snapshot = {
      data: {
        tree: serializeTreeForApi(tree.root),
        blackboard: state?.blackboard ?? {},
        stats: { ...this.stats, asOfEventId: this.eventStream.latestId },
      },
      id: '0',
    };
    handleSseStream(req, res, snapshot, this.eventStream, this.sseClients, { replayOnConnect: true });
  }

  private forwardEvent(event: { type: string; data: Record<string, unknown> }): void {
    this.trackEvent(event);
    this.eventStream.push(event.type, event.data);
  }

  private trackEvent(event: { type: string; data: Record<string, unknown> }): void {
    if (event.type === 'tree:tick') {
      this.stats.tickCount++;
      this.stats.lastStatus = event.data.status as string;
      this.stats.lastDurationMs = event.data.durationMs as number;
      if (event.data.status !== 'running') {
        this.stats.cycleCount++;
      }
    }
  }

}
