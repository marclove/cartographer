import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { BehaviorTree } from '../core/behavior-tree.js';
import { NodeStatus } from '../types.js';
import type { TreeEvents } from '../types.js';
import { InProcessEventStream } from './event-stream.js';
import { serializeEvent } from './serializers.js';
import { handleApiTree, handleApiStatus, handleApiBlackboard, handleApiNode } from './api-handlers.js';
import type { StatusState } from './api-handlers.js';
import { handleSseStream } from './sse-handler.js';
import type { SseClient } from './sse-handler.js';
import { jsonError } from './http-utils.js';

export interface TreeServerOptions {
  port?: number;
  eventStreamCapacity?: number;
}

export class TreeServer {
  private server: Server | null = null;
  private readonly eventStream: InProcessEventStream;
  private readonly sseClients: Set<SseClient> = new Set();
  private readonly state: StatusState;
  private readonly port: number;
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly tree: BehaviorTree,
    options: TreeServerOptions = {},
  ) {
    this.port = options.port ?? 3147;
    this.eventStream = new InProcessEventStream(options.eventStreamCapacity ?? 500);
    this.state = {
      tickCount: 0,
      cycleCount: 0,
      lastStatus: null,
      lastDurationMs: null,
      startedAt: Date.now(),
    };
  }

  async start(): Promise<{ port: number }> {
    this.subscribeToEvents();

    this.server = createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(this.port, () => {
        const addr = this.server!.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
        resolve({ port: actualPort });
      });
    });
  }

  async close(): Promise<void> {
    // Unsubscribe from tree events
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    // Close all SSE connections
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    // Shut down the HTTP server
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  private subscribeToEvents(): void {
    // Track tick stats
    const onTick = (data: TreeEvents['tree:tick']) => {
      this.state.tickCount++;
      this.state.lastStatus = data.status;
      if (data.status !== NodeStatus.RUNNING) {
        this.state.cycleCount++;
      }
      this.state.lastDurationMs = data.durationMs;
    };
    this.tree.events.on('tree:tick', onTick);
    this.unsubscribers.push(() => this.tree.events.off('tree:tick', onTick));

    // Forward all events to the event stream (subscribers handle SSE delivery)
    const onAnyEvent = (event: string, data: unknown) => {
      const serialized = serializeEvent(event as any, data);
      this.eventStream.push(event, serialized);
    };
    this.tree.events.onAny(onAnyEvent);
    this.unsubscribers.push(() => this.tree.events.offAny(onAnyEvent));
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    // API routes
    if (pathname === '/api/tree') {
      handleApiTree(res, this.tree);
      return;
    }
    if (pathname === '/api/status') {
      handleApiStatus(res, this.tree, this.state);
      return;
    }
    if (pathname === '/api/blackboard') {
      handleApiBlackboard(res, this.tree);
      return;
    }
    if (pathname.startsWith('/api/nodes/')) {
      const nodeId = pathname.slice('/api/nodes/'.length);
      handleApiNode(res, this.tree, decodeURIComponent(nodeId));
      return;
    }
    if (pathname.startsWith('/api/')) {
      jsonError(res, 404, 'Not found');
      return;
    }

    // SSE endpoint
    if (pathname === '/events') {
      handleSseStream(req, res, this.tree, this.eventStream, this.sseClients);
      return;
    }

    jsonError(res, 404, 'Not found');
  }
}
