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
import { sendSseEvent, blackboardToRecord } from './sse-handler.js';
import type { SseClient } from './sse-handler.js';
import { serializeTree as serializeTreeForApi, serializeEvent } from './serializers.js';
import { handleApiNode } from './api-handlers.js';
import type { StatusState } from './api-handlers.js';

function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> | void;

interface Route {
  method: string;
  pattern: string;
  handler: RouteHandler;
}

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const pathParts = pathname.split('/');
  const patternParts = pattern.split('/');
  if (pathParts.length !== patternParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

export interface ActorServerOptions {
  createTree: () => BehaviorTree;
  stateStore?: StateStore;
  port?: number;
  context?: Record<string, unknown>;
  topologyPolicy?: 'fail' | 'reset';
  maxQueueDepth?: number;
}

export interface QueuedResult {
  queued: true;
  messageId: string;
  position: number;
}

export class ActorServer {
  private static readonly STATE_KEY = 'default';

  private readonly createTree: () => BehaviorTree;
  readonly stateStore: StateStore;
  private readonly configPort: number;
  private readonly context: Record<string, unknown>;
  readonly topologyPolicy: 'fail' | 'reset';
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
      { method: 'GET',  pattern: '/_platform/health',     handler: (_req, res) => this.handleHealth(res) },
      { method: 'GET',  pattern: '/api/blackboard',       handler: (_req, res) => this.handleBlackboardRead(res) },
      { method: 'GET',  pattern: '/api/status',           handler: (_req, res) => this.handleStatus(res) },
      { method: 'GET',  pattern: '/api/tree',             handler: (_req, res) => this.handleTreeRead(res) },
      { method: 'GET',  pattern: '/api/nodes/:id',        handler: (_req, res, p) => handleApiNode(res, this.readTree, p.id) },
      { method: 'GET',  pattern: '/events',               handler: (req, res) => this.handleSSE(req, res) },
      { method: 'POST', pattern: '/api/messages',         handler: (req, res) => this.handleMessage(req, res) },
      { method: 'POST', pattern: '/api/commands/:name',   handler: (req, res, p) => this.handleCommand(req, res, p.name) },
      { method: 'POST', pattern: '/api/blackboard/:key',  handler: (req, res, p) => this.handleBlackboardWrite(req, res, p.key) },
      { method: 'POST', pattern: '/api/interrupt',        handler: (_req, res) => this.handleInterrupt(res) },
      { method: 'POST', pattern: '/api/resume',           handler: (_req, res) => this.handleResume(res) },
    ];
  }

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
   * Used to bridge TreeScheduler events to dashboard clients.
   */
  bridgeTree(tree: BehaviorTree): void {
    tree.events.onAny((type, data) => {
      const serialized = serializeEvent(type as any, data as any);
      this.forwardEvent({ type, data: serialized });
    });
  }

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

  private handleHealth(res: ServerResponse): void {
    jsonResponse(res, 200, {
      status: 'ok',
      uptime: Math.floor((Date.now() - this.stats.startedAt) / 1000),
    });
  }

  private async handleBlackboardRead(res: ServerResponse): Promise<void> {
    const state = await this.stateStore.getState(ActorServer.STATE_KEY);
    jsonResponse(res, 200, state?.blackboard ?? {});
  }

  private handleStatus(res: ServerResponse): void {
    const tree = this.readTree;
    jsonResponse(res, 200, {
      tree: tree.name,
      ...this.stats,
      uptime: Date.now() - this.stats.startedAt,
    });
  }

  private handleTreeRead(res: ServerResponse): void {
    const tree = this.readTree;
    jsonResponse(res, 200, { tree: tree.name, root: serializeTreeForApi(tree.root) });
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
   * Process a message programmatically (no HTTP response needed).
   * If the lock is held, the message is queued and a {@link QueuedResult} is returned.
   * Returns null only if the queue is full.
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
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Build snapshot from readTree (structure) + state store (blackboard) + stats
    const tree = this.readTree;
    const state = await this.stateStore.getState(ActorServer.STATE_KEY);
    const snapshot = {
      tree: serializeTreeForApi(tree.root),
      blackboard: state?.blackboard ?? {},
      stats: { ...this.stats, asOfEventId: this.eventStream.latestId },
    };

    // Send snapshot
    sendSseEvent(res, 'snapshot', snapshot, '0');

    // Replay buffered events — on reconnect, replay since last-event-id;
    // on initial connect, replay the entire buffer so the dashboard
    // shows events that occurred before the client connected.
    const lastEventId = req.headers['last-event-id'] as string | undefined;
    const sinceId = lastEventId ?? '0';
    const events = this.eventStream.replaySince(sinceId);
    if (events !== null) {
      for (const event of events) {
        sendSseEvent(res, event.event, event.data, event.id);
      }
    }

    // Subscribe to live events
    const unsubscribe = this.eventStream.subscribe((entry) => {
      sendSseEvent(res, entry.event, entry.data, entry.id);
    });

    this.sseClients.add(res);
    req.on('close', () => {
      unsubscribe();
      this.sseClients.delete(res);
    });
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
