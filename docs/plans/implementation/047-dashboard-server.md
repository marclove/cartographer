# Task 47: Dashboard HTTP Server

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the core HTTP server that routes requests to REST handlers, SSE handler, and static file serving for the dashboard. This is the main orchestrator — handlers are implemented in Tasks 48–49.

**Depends on:** Task 45, Task 46

---

### Step 1: Expose root as a public readonly property on BehaviorTree

Edit `src/core/behavior-tree.ts` — change the `root` property from `private` to `public readonly`:

```ts
// Change:
private root: BTreeNode;
// To:
readonly root: BTreeNode;
```

This is needed because the dashboard server must walk the tree structure to serialize it for the `/api/tree` endpoint and SSE snapshots.

Run: `npm run typecheck && npm run test`
Expected: All pass — widening visibility is a compatible change.

### Step 2: Write failing tests

Create `src/server/dashboard-server.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { DashboardServer } from './dashboard-server.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import { ActionNode } from '../nodes/action.js';
import { NodeStatus } from '../types.js';

function createTestTree() {
  const root = new ActionNode({ name: 'TestAction', id: 'test-action', action: async () => NodeStatus.SUCCESS });
  return new BehaviorTree({ name: 'TestTree', root, blackboard: new InMemoryBlackboard() });
}

describe('DashboardServer', () => {
  let server: DashboardServer;

  afterEach(async () => {
    if (server) await server.close();
  });

  it('starts on specified port and responds to /api/status', async () => {
    const tree = createTestTree();
    server = new DashboardServer(tree, { port: 0 }); // port 0 = auto-assign
    const { port } = await server.start();

    const res = await fetch(`http://localhost:${port}/api/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.tree).toBe('TestTree');
  });

  it('returns 404 for unknown routes', async () => {
    const tree = createTestTree();
    server = new DashboardServer(tree, { port: 0 });
    const { port } = await server.start();

    const res = await fetch(`http://localhost:${port}/api/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('returns JSON error format', async () => {
    const tree = createTestTree();
    server = new DashboardServer(tree, { port: 0 });
    const { port } = await server.start();

    const res = await fetch(`http://localhost:${port}/api/nodes/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not found', status: 404 });
  });

  it('close() shuts down the server', async () => {
    const tree = createTestTree();
    server = new DashboardServer(tree, { port: 0 });
    const { port } = await server.start();
    await server.close();

    await expect(fetch(`http://localhost:${port}/api/status`)).rejects.toThrow();
  });
});
```

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/server/dashboard-server.test.ts`
Expected: FAIL — module does not exist.

### Step 3: Implement DashboardServer

Create `src/server/dashboard-server.ts`:

```ts
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BehaviorTree } from '../core/behavior-tree.js';
import type { TreeEvents } from '../types.js';
import { EventBuffer } from './event-buffer.js';
import { serializeEvent, serializeTree, serializeNodeRef } from './serializers.js';
import { handleApiTree, handleApiStatus, handleApiBlackboard, handleApiNode } from './api-handlers.js';
import { handleSSE } from './sse-handler.js';

export interface DashboardServerOptions {
  port?: number;
  eventBufferCapacity?: number;
}

interface ServerState {
  tickCount: number;
  lastStatus: string | null;
  lastDurationMs: number | null;
  startTime: number;
}

export class DashboardServer {
  private httpServer: http.Server | null = null;
  private readonly eventBuffer: EventBuffer;
  private readonly state: ServerState;
  private readonly cleanup: Array<() => void> = [];
  private readonly sseClients = new Set<http.ServerResponse>();

  constructor(
    private readonly tree: BehaviorTree,
    private readonly options: DashboardServerOptions = {},
  ) {
    this.eventBuffer = new EventBuffer(options.eventBufferCapacity ?? 1000);
    this.state = { tickCount: 0, lastStatus: null, lastDurationMs: null, startTime: Date.now() };
    this.subscribeToEvents();
  }

  async start(): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      const port = this.options.port ?? 3147;
      server.listen(port, () => {
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        this.httpServer = server;
        resolve({ port: actualPort });
      });
      server.on('error', reject);
    });
  }

  async close(): Promise<void> {
    for (const off of this.cleanup) off();
    for (const client of this.sseClients) client.end();
    this.sseClients.clear();

    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private subscribeToEvents(): void {
    const events = this.tree.events;
    const allEvents: Array<keyof TreeEvents> = [
      'node:enter', 'node:exit', 'node:error',
      'agent:prompt', 'agent:thinking', 'agent:text', 'agent:tool_use',
      'agent:response', 'agent:error', 'agent:message', 'agent:tool_progress',
      'agent:init', 'agent:status', 'agent:rate_limit', 'agent:elicitation_declined',
      // Note: 'agent:stream' is intentionally excluded — too noisy, covered by agent:text/thinking.
      // The SSE handler can include it when ?verbose=true is passed.
      'tree:init', 'tree:tick', 'tree:reset', 'tree:abort',
      'blackboard:write', 'strategy:decision',
    ];

    for (const eventName of allEvents) {
      const handler = (data: any) => {
        if (eventName === 'tree:tick') {
          this.state.tickCount++;
          this.state.lastStatus = data.status;
          this.state.lastDurationMs = data.durationMs;
        }
        const serialized = serializeEvent(eventName, data);
        const entry = this.eventBuffer.push(eventName, serialized);
        this.broadcastSSE(entry);
      };
      events.on(eventName, handler);
      this.cleanup.push(() => events.off(eventName, handler));
    }
  }

  private broadcastSSE(entry: { id: number; event: string; data: Record<string, unknown>; ts: string }): void {
    const message = `id: ${entry.id}\nevent: ${entry.event}\ndata: ${JSON.stringify({ ...entry.data, ts: entry.ts })}\n\n`;
    for (const client of this.sseClients) {
      client.write(message);
    }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    // API routes
    if (pathname === '/api/tree' && req.method === 'GET') {
      return handleApiTree(this.tree, res);
    }
    if (pathname === '/api/status' && req.method === 'GET') {
      return handleApiStatus(this.tree, this.state, res);
    }
    if (pathname === '/api/blackboard' && req.method === 'GET') {
      return handleApiBlackboard(this.tree, res);
    }
    if (pathname.startsWith('/api/nodes/') && req.method === 'GET') {
      const nodeId = pathname.slice('/api/nodes/'.length);
      return handleApiNode(this.tree, nodeId, res);
    }
    if (pathname === '/api/events' && req.method === 'GET') {
      const lastEventId = req.headers['last-event-id'] as string | undefined;
      return handleSSE(this.tree, this.eventBuffer, this.sseClients, lastEventId, res);
    }

    // Static dashboard files
    if (!pathname.startsWith('/api')) {
      return this.serveStatic(pathname, res);
    }

    jsonError(res, 404, 'Not found');
  }

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    const dashboardDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../dashboard',
    );
    const filePath = path.join(dashboardDir, pathname === '/' ? 'index.html' : pathname);
    const resolved = path.resolve(filePath);

    // Prevent path traversal
    if (!resolved.startsWith(dashboardDir)) {
      return jsonError(res, 403, 'Forbidden');
    }

    fs.readFile(resolved, (err, data) => {
      if (err) {
        return jsonError(res, 404, 'Not found');
      }
      const ext = path.extname(resolved).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.woff2': 'font/woff2',
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream' });
      res.end(data);
    });
  }
}

export function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function jsonError(res: http.ServerResponse, status: number, message: string): void {
  jsonResponse(res, status, { error: message, status });
}
```

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/server/dashboard-server.test.ts`
Expected: FAIL — `api-handlers.js` and `sse-handler.js` don't exist yet. Create empty stubs for now:

Create `src/server/api-handlers.ts` with stub exports:

```ts
import type http from 'node:http';
import type { BehaviorTree } from '../core/behavior-tree.js';
import { jsonResponse, jsonError } from './dashboard-server.js';
import { serializeTree, serializeNodeRef, getNodeType } from './serializers.js';

export function handleApiTree(tree: BehaviorTree, res: http.ServerResponse): void {
  jsonResponse(res, 200, { tree: tree.name, root: serializeTree(tree.root) });
}

export function handleApiStatus(tree: BehaviorTree, state: any, res: http.ServerResponse): void {
  jsonResponse(res, 200, {
    tree: tree.name,
    tickCount: state.tickCount,
    lastStatus: state.lastStatus,
    lastDurationMs: state.lastDurationMs,
    uptime: Date.now() - state.startTime,
  });
}

export function handleApiBlackboard(tree: BehaviorTree, res: http.ServerResponse): void {
  const bb = tree.blackboard;
  const data: Record<string, unknown> = {};
  for (const key of bb.keys()) {
    data[key] = bb.get(key);
  }
  jsonResponse(res, 200, data);
}

export function handleApiNode(tree: BehaviorTree, nodeId: string, res: http.ServerResponse): void {
  const node = findNode(tree.root, nodeId);
  if (!node) return jsonError(res, 404, 'Not found');
  jsonResponse(res, 200, serializeNodeRef(node));
}

function findNode(node: any, id: string): any | null {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}
```

Create `src/server/sse-handler.ts` with stub:

```ts
import type http from 'node:http';
import type { BehaviorTree } from '../core/behavior-tree.js';
import type { EventBuffer } from './event-buffer.js';
import { serializeTree } from './serializers.js';

export function handleSSE(
  tree: BehaviorTree,
  buffer: EventBuffer,
  clients: Set<http.ServerResponse>,
  lastEventId: string | undefined,
  res: http.ServerResponse,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  clients.add(res);
  res.on('close', () => clients.delete(res));

  // Send snapshot
  const snapshot = {
    tree: { name: tree.name, root: serializeTree(tree.root) },
    blackboard: Object.fromEntries(tree.blackboard.keys().map((k) => [k, tree.blackboard.get(k)])),
  };
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

  // Replay missed events if reconnecting
  if (lastEventId) {
    const missed = buffer.getEventsSince(parseInt(lastEventId, 10));
    if (missed) {
      for (const entry of missed) {
        res.write(`id: ${entry.id}\nevent: ${entry.event}\ndata: ${JSON.stringify({ ...entry.data, ts: entry.ts })}\n\n`);
      }
    }
  }
}
```

### Step 5: Run tests again

Run: `npx vitest run src/server/dashboard-server.test.ts`
Expected: All pass.

### Step 6: Typecheck

Run: `npm run typecheck`
Expected: All pass.

### Step 7: Commit

```bash
git add src/server/dashboard-server.ts src/server/dashboard-server.test.ts src/server/api-handlers.ts src/server/sse-handler.ts
git commit -m "feat(server): add dashboard HTTP server with routing and static serving"
```
