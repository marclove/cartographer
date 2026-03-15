import type { ServerResponse } from 'node:http';

export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function jsonError(res: ServerResponse, status: number, message: string): void {
  jsonResponse(res, status, { error: message, status });
}
