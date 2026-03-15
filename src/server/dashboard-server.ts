import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { join, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { BehaviorTree } from '../core/behavior-tree.js';
import type { TreeEvents } from '../types.js';
import { EventBuffer } from './event-buffer.js';
import { serializeEvent } from './serializers.js';
import { handleApiTree, handleApiStatus, handleApiBlackboard, handleApiNode } from './api-handlers.js';
import type { StatusState } from './api-handlers.js';
import { handleSseStream, broadcastSseEvent } from './sse-handler.js';
import type { SseClient } from './sse-handler.js';

export interface DashboardServerOptions {
  port?: number;
  eventBufferCapacity?: number;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Events that are too noisy or too large to broadcast to the dashboard. */
const EXCLUDED_EVENTS: ReadonlySet<keyof TreeEvents> = new Set(['agent:stream']);

export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function jsonError(res: ServerResponse, status: number, message: string): void {
  jsonResponse(res, status, { error: message, status });
}

export class DashboardServer {
  private server: Server | null = null;
  private readonly eventBuffer: EventBuffer;
  private readonly sseClients: Set<SseClient> = new Set();
  private readonly state: StatusState;
  private readonly port: number;
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly tree: BehaviorTree,
    options: DashboardServerOptions = {},
  ) {
    this.port = options.port ?? 3147;
    this.eventBuffer = new EventBuffer(options.eventBufferCapacity ?? 500);
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
      // Increment cycle count at the start of a new cycle — when the previous
      // tick was terminal (or this is the very first tick, i.e. lastStatus is null).
      if (this.state.lastStatus !== 'running') {
        this.state.cycleCount++;
      }
      this.state.lastStatus = data.status;
      this.state.lastDurationMs = data.durationMs;
    };
    this.tree.events.on('tree:tick', onTick);
    this.unsubscribers.push(() => this.tree.events.off('tree:tick', onTick));

    // Subscribe to all events except excluded ones → serialize → buffer → broadcast
    const eventNames: Array<keyof TreeEvents> = [
      'node:enter', 'node:exit', 'node:error',
      'agent:prompt', 'agent:thinking', 'agent:text', 'agent:tool_use',
      'agent:response', 'agent:error', 'agent:message', 'agent:tool_progress',
      'agent:init', 'agent:status', 'agent:rate_limit', 'agent:elicitation_declined',
      'tree:init', 'tree:tick', 'tree:tick:skipped', 'tree:reset', 'tree:abort',
      'blackboard:write', 'strategy:decision',
    ];

    for (const eventName of eventNames) {
      if (EXCLUDED_EVENTS.has(eventName)) continue;
      const listener = (data: any) => {
        const serialized = serializeEvent(eventName, data);
        const entry = this.eventBuffer.push(eventName, serialized);
        broadcastSseEvent(this.sseClients, entry);
      };
      this.tree.events.on(eventName, listener);
      this.unsubscribers.push(() => this.tree.events.off(eventName, listener));
    }
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
      handleSseStream(req, res, this.tree, this.eventBuffer, this.sseClients);
      return;
    }

    // Static file serving from dist/dashboard/
    this.serveStaticFile(pathname, res);
  }

  private async serveStaticFile(pathname: string, res: ServerResponse): Promise<void> {
    // Determine the static files directory relative to this module
    const thisDir = typeof __dirname !== 'undefined'
      ? __dirname
      : fileURLToPath(new URL('.', import.meta.url));
    const staticDir = join(thisDir, '..', '..', 'dist', 'dashboard');

    // Resolve to index.html for root
    let filePath = pathname === '/' ? '/index.html' : pathname;

    // Path traversal prevention
    const resolved = join(staticDir, filePath);
    if (!resolved.startsWith(staticDir)) {
      jsonError(res, 403, 'Forbidden');
      return;
    }

    try {
      const content = await readFile(resolved);
      const ext = extname(resolved);
      const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      jsonError(res, 404, 'Not found');
    }
  }
}
