import type { IncomingMessage, ServerResponse } from 'node:http';

export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function jsonError(res: ServerResponse, status: number, message: string): void {
  jsonResponse(res, status, { error: message, status });
}

export function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve(null); }
    });
  });
}
