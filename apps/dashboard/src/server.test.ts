import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
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
  let apiConnections: Set<Socket>;

  // Start a tiny mock API server to test proxying
  async function startMockApi(): Promise<void> {
    apiConnections = new Set();
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
      apiServer.on('connection', (socket) => {
        apiConnections.add(socket);
        socket.on('close', () => apiConnections.delete(socket));
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
    for (const socket of apiConnections) {
      socket.destroy();
    }
    apiConnections.clear();
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
