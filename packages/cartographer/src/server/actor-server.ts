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
import { serializeTree as serializeTreeForApi, serializeNodeRef, serializeEvent } from './serializers.js';
import { findNodeById } from './api-handlers.js';
import type { StatusState } from './api-handlers.js';
import { AgentNode } from '../nodes/agent.js';

function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface ActorServerOptions {
  createTree: () => BehaviorTree;
  stateStore?: StateStore;
  port?: number;
  context?: Record<string, unknown>;
  topologyPolicy?: 'fail' | 'reset';
}

export class ActorServer {
  private readonly createTree: () => BehaviorTree;
  readonly stateStore: StateStore;
  private readonly configPort: number;
  private readonly context: Record<string, unknown>;
  readonly topologyPolicy: 'fail' | 'reset';
  private server: Server | null = null;
  private activeActor: TreeActor | null = null;
  private activeMessageId: string | null = null;
  private readonly stats: StatusState = { tickCount: 0, cycleCount: 0, lastStatus: null, lastDurationMs: null, startedAt: 0 };
  private readonly eventStream: EventStream = new InProcessEventStream(500);
  private readonly sseClients: Set<SseClient> = new Set();
  private _readTree: BehaviorTree | null = null;

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
  }

  async start(): Promise<{ port: number }> {
    this.stats.startedAt = Date.now();

    const existing = await this.stateStore.getState('default');
    if (!existing) {
      await this.initializeDefaultState();
    }

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          jsonError(res, 500, err instanceof Error ? err.message : 'Internal error');
        }
      });
    });

    return new Promise((resolve) => {
      this.server!.listen(this.configPort, () => {
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
    await this.stateStore.saveState('default', {
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

    // Platform health
    if (method === 'GET' && url.pathname === '/_platform/health') {
      return jsonResponse(res, 200, {
        status: 'ok',
        uptime: Math.floor((Date.now() - this.stats.startedAt) / 1000),
      });
    }

    // Read endpoints
    if (method === 'GET' && url.pathname === '/api/blackboard') {
      const state = await this.stateStore.getState('default');
      return jsonResponse(res, 200, state?.blackboard ?? {});
    }

    if (method === 'GET' && url.pathname === '/api/status') {
      const tree = this.readTree;
      return jsonResponse(res, 200, {
        tree: tree.name,
        ...this.stats,
        uptime: Date.now() - this.stats.startedAt,
      });
    }

    if (method === 'GET' && url.pathname === '/api/tree') {
      const tree = this.readTree;
      return jsonResponse(res, 200, { tree: tree.name, root: serializeTreeForApi(tree.root) });
    }

    const nodeMatch = url.pathname.match(/^\/api\/nodes\/(.+)$/);
    if (method === 'GET' && nodeMatch) {
      const tree = this.readTree;
      const nodeId = decodeURIComponent(nodeMatch[1]);
      const node = findNodeById(tree.root, nodeId);
      if (!node) {
        return jsonError(res, 404, 'Not found');
      }
      const detail: Record<string, unknown> = { ...serializeNodeRef(node) };
      if (node instanceof AgentNode) {
        const opts = node.agentOptions;
        if (opts.model) detail.model = opts.model;
        detail.tools = opts.allowedTools ?? [];
        detail.mcpServers = opts.mcpServers ? Object.keys(opts.mcpServers) : [];
      }
      if (node.children.length > 0) {
        detail.children = node.children.map(serializeNodeRef);
      }
      return jsonResponse(res, 200, detail);
    }

    if (method === 'GET' && url.pathname === '/events') {
      return this.handleSSE(req, res);
    }

    // Write endpoints
    if (method === 'POST' && url.pathname === '/api/messages') {
      return this.handleMessage(req, res);
    }

    const actionMatch = url.pathname.match(/^\/api\/actions\/(.+)$/);
    if (method === 'POST' && actionMatch) {
      return this.handleAction(req, res, decodeURIComponent(actionMatch[1]));
    }

    const bbMatch = url.pathname.match(/^\/api\/blackboard\/(.+)$/);
    if (method === 'POST' && bbMatch) {
      return this.handleBlackboardWrite(req, res, decodeURIComponent(bbMatch[1]));
    }

    if (method === 'POST' && url.pathname === '/api/interrupt') {
      return this.handleInterrupt(res);
    }

    if (method === 'POST' && url.pathname === '/api/resume') {
      return this.handleResume(res);
    }

    jsonError(res, 404, 'Not found');
  }

  private async handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (!body || !body.type) {
      return jsonError(res, 400, 'Missing message type');
    }
    if (body.type === 'action' && !body.name) {
      return jsonError(res, 400, 'Action message requires name');
    }
    await this.processAsync({ ...body }, res, body.id);
  }

  private async handleAction(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const payload = await readBody(req);
    await this.processAsync({ type: 'action', name, payload }, res);
  }

  private async handleBlackboardWrite(req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
    const body = await readBody(req);
    const value = body?.value;
    await this.processAsync({ type: 'write', key, value }, res);
  }

  /**
   * Process a message programmatically (no HTTP response needed).
   * Returns null if the lock could not be acquired (another message is processing).
   */
  async processMessage(msg: ActorMessage): Promise<ProcessResult | null> {
    const requestId = generateRequestId();

    const acquired = await this.stateStore.acquireLock('default', requestId, 30000);
    if (!acquired) return null;

    const bridge = new EventBridge(this.stateStore, 'default', msg.id, (event) => this.forwardEvent(event));
    msg.id = bridge.messageId;

    return this.executeMessage(msg, requestId, bridge);
  }

  private async processAsync(msg: ActorMessage, res: ServerResponse, clientMessageId?: string): Promise<void> {
    const requestId = generateRequestId();

    const acquired = await this.stateStore.acquireLock('default', requestId, 30000);
    if (!acquired) {
      return jsonError(res, 409, 'Processing in progress');
    }

    const bridge = new EventBridge(this.stateStore, 'default', clientMessageId, (event) => this.forwardEvent(event));
    msg.id = bridge.messageId;

    // Respond immediately, process in background
    jsonResponse(res, 202, { id: bridge.messageId, status: 'processing' });
    this.executeMessage(msg, requestId, bridge).catch(() => {});
  }

  private async executeMessage(
    msg: ActorMessage,
    requestId: string,
    bridge: EventBridge,
  ): Promise<ProcessResult> {
    const heartbeat = setInterval(async () => {
      try { await this.stateStore.acquireLock('default', requestId, 30000); } catch {}
    }, 10000);

    try {
      const actor = new TreeActor({
        createTree: this.createTree,
        stateStore: this.stateStore,
        stateKey: 'default',
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
      await this.stateStore.releaseLock('default', requestId);
    }
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
    const state = await this.stateStore.getState('default');
    if (state?.held) {
      await this.stateStore.saveState('default', { ...state, held: false });
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
    const state = await this.stateStore.getState('default');
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
