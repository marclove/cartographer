import { describe, it, expect, vi } from 'vitest';
import { jsonResponse, jsonError } from './http-utils.js';
import type { ServerResponse } from 'node:http';

function mockResponse() {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
}

describe('jsonResponse', () => {
  it('writes JSON content-type header and stringified body', () => {
    const res = mockResponse();
    jsonResponse(res, 200, { ok: true });

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });

  it('uses the provided status code', () => {
    const res = mockResponse();
    jsonResponse(res, 201, { created: true });

    expect(res.writeHead).toHaveBeenCalledWith(201, { 'Content-Type': 'application/json' });
  });
});

describe('jsonError', () => {
  it('writes error object with message and status', () => {
    const res = mockResponse();
    jsonError(res, 404, 'Not found');

    expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'Not found', status: 404 }));
  });
});
