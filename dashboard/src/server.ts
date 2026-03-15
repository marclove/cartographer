import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Socket } from 'node:net';
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
  private readonly connections = new Set<Socket>();
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

    this.server.on('connection', (socket) => {
      this.connections.add(socket);
      socket.on('close', () => this.connections.delete(socket));
    });

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
      // Destroy all open connections so the server can close immediately
      for (const socket of this.connections) {
        socket.destroy();
      }
      this.connections.clear();
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
