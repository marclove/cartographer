# Task 78: Dashboard Server

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a static file server with API reverse proxy in `dashboard/src/server.ts`. It serves the built Svelte app and proxies `/api/*` and `/events` requests to the TreeServer. No behavior-tree dependencies.

**Depends on:** Task 77

---

### Step 1: Create dashboard tsconfig for server compilation

Create `dashboard/tsconfig.server.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "../dist/dashboard-server",
    "rootDir": "./src",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src/server.ts"]
}
```

### Step 2: Write failing tests

Create `dashboard/src/server.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { DashboardServer } from './server.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

// Create a temporary static directory with test files
const thisDir = fileURLToPath(new URL('.', import.meta.url));
const tmpDir = join(thisDir, '../../.test-static');

function setupStaticDir() {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'index.html'), '<html><body>hello</body></html>');
  writeFileSync(join(tmpDir, 'app.js'), 'console.log("app")');
  writeFileSync(join(tmpDir, 'style.css'), 'body { margin: 0 }');
}

function cleanupStaticDir() {
  rmSync(tmpDir, { recursive: true, force: true });
}

describe('DashboardServer', () => {
  let server: DashboardServer;
  let apiServer: Server;
  let apiPort: number;

  // Start a tiny mock API server to test proxying
  async function startMockApi(): Promise<void> {
    return new Promise((resolve) => {
      apiServer = createServer((req, res) => {
        if (req.url === '/api/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tree: 'MockTree', tickCount: 0 }));
        } else if (req.url === '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          res.write('event: snapshot\ndata: {"mock":true}\n\n');
          // Keep connection open
        } else {
          res.writeHead(404);
          res.end('not found');
        }
      });
      apiServer.listen(0, () => {
        const addr = apiServer.address();
        apiPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  }

  beforeAll(() => {
    setupStaticDir();
  });

  afterAll(() => {
    cleanupStaticDir();
  });

  beforeEach(async () => {
    await startMockApi();
  });

  afterEach(async () => {
    if (server) await server.close();
    await new Promise<void>((r) => apiServer.close(() => r()));
  });

  it('serves static files with correct MIME types', async () => {
    server = new DashboardServer({
      port: 0,
      staticDir: tmpDir,
      apiUrl: `http://localhost:${apiPort}`,
    });
    const { port } = await server.start();

    const html = await fetch(`http://localhost:${port}/`);
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toBe('text/html');
    expect(await html.text()).toContain('hello');

    const js = await fetch(`http://localhost:${port}/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('application/javascript');

    const css = await fetch(`http://localhost:${port}/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css');
  });

  it('falls back to index.html for SPA routes', async () => {
    server = new DashboardServer({
      port: 0,
      staticDir: tmpDir,
      apiUrl: `http://localhost:${apiPort}`,
    });
    const { port } = await server.start();

    const res = await fetch(`http://localhost:${port}/some/spa/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('hello');
  });

  it('proxies /api/* requests to the API server', async () => {
    server = new DashboardServer({
      port: 0,
      staticDir: tmpDir,
      apiUrl: `http://localhost:${apiPort}`,
    });
    const { port } = await server.start();

    const res = await fetch(`http://localhost:${port}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tree).toBe('MockTree');
  });

  it('proxies /events SSE requests to the API server', async () => {
    server = new DashboardServer({
      port: 0,
      staticDir: tmpDir,
      apiUrl: `http://localhost:${apiPort}`,
    });
    const { port } = await server.start();

    const controller = new AbortController();
    const res = await fetch(`http://localhost:${port}/events`, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    controller.abort();
  });

  it('prevents path traversal', async () => {
    server = new DashboardServer({
      port: 0,
      staticDir: tmpDir,
      apiUrl: `http://localhost:${apiPort}`,
    });
    const { port } = await server.start();

    const res = await fetch(`http://localhost:${port}/../package.json`);
    // Should either 403 or fall back to index.html, not serve the file
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      const text = await res.text();
      expect(text).toContain('hello'); // SPA fallback, not package.json
    }
  });

  it('close() shuts down the server', async () => {
    server = new DashboardServer({
      port: 0,
      staticDir: tmpDir,
      apiUrl: `http://localhost:${apiPort}`,
    });
    const { port } = await server.start();
    await server.close();

    await expect(fetch(`http://localhost:${port}/`)).rejects.toThrow();
  });
});
```

### Step 3: Add the dashboard test file to vitest config

Check `vitest.config.ts` — the dashboard tests may need a project entry. If there is already a `dashboard` vitest project, add `src/server.test.ts` to its include pattern. If not, the test can be run directly:

Run: `npx vitest run dashboard/src/server.test.ts`
Expected: FAIL — module `./server.js` does not exist.

### Step 4: Implement DashboardServer

Create `dashboard/src/server.ts`:

```ts
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { join, extname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

export interface DashboardServerOptions {
  port?: number;
  staticDir: string;
  apiUrl: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export class DashboardServer {
  private server: Server | null = null;
  private readonly port: number;
  private readonly staticDir: string;
  private readonly apiUrl: string;

  constructor(options: DashboardServerOptions) {
    this.port = options.port ?? 3148;
    this.staticDir = resolve(options.staticDir);
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
  }

  async start(): Promise<{ port: number }> {
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
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    // Proxy API and SSE requests to the TreeServer
    if (pathname.startsWith('/api/') || pathname === '/events') {
      this.proxy(req, res);
      return;
    }

    // Serve static files
    this.serveStaticFile(pathname, res);
  }

  private proxy(req: IncomingMessage, res: ServerResponse): void {
    const targetUrl = new URL(req.url ?? '/', this.apiUrl);

    const proxyReq = httpRequest(
      targetUrl,
      {
        method: req.method,
        headers: {
          ...req.headers,
          host: targetUrl.host,
        },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API server unavailable', status: 502 }));
    });

    req.pipe(proxyReq);
  }

  private async serveStaticFile(pathname: string, res: ServerResponse): Promise<void> {
    let filePath = pathname === '/' ? '/index.html' : pathname;

    const resolved = resolve(join(this.staticDir, filePath));

    // Path traversal prevention
    if (!resolved.startsWith(this.staticDir)) {
      return this.serveIndex(res);
    }

    try {
      const content = await readFile(resolved);
      const ext = extname(resolved);
      const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      // SPA fallback — serve index.html for unrecognized paths
      return this.serveIndex(res);
    }
  }

  private async serveIndex(res: ServerResponse): Promise<void> {
    try {
      const content = await readFile(join(this.staticDir, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', status: 404 }));
    }
  }
}
```

### Step 5: Run tests to verify they pass

Run: `npx vitest run dashboard/src/server.test.ts`
Expected: All pass.

### Step 6: Verify the dashboard server compiles

Run: `npx tsc -p dashboard/tsconfig.server.json`
Expected: Compiles to `dist/dashboard-server/server.js` with no errors.

### Step 7: Add compilation to build script

Edit `package.json` — update the `build` script:

```json
"build": "tsc && npm run dashboard:build && tsc -p dashboard/tsconfig.server.json",
```

### Step 8: Update typecheck script

Edit `package.json` — update the `typecheck` script to include the dashboard server:

```json
"typecheck": "tsc --noEmit && tsc --noEmit -p examples/tsconfig.json && tsc --noEmit -p dashboard/tsconfig.server.json",
```

### Step 9: Run full build

Run: `npm run build`
Expected: All pass. `dist/dashboard-server/server.js` exists.

### Step 10: Commit

```bash
git add dashboard/src/server.ts dashboard/src/server.test.ts dashboard/tsconfig.server.json package.json
git commit -m "feat(dashboard): add static file server with API reverse proxy"
```
