import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  sendSseEvent,
  blackboardToRecord,
  broadcastSseEvent,
  handleSseStream,
} from './sse-handler.js';

// Mock serializeTree so we don't pull in real node classes
vi.mock('./serializers.js', () => ({
  serializeTree: vi.fn(() => ({ id: 'root', name: 'root', type: 'sequence', children: [] })),
}));

function makeRes() {
  return {
    writeHead: vi.fn(),
    write: vi.fn(),
  } as unknown as import('node:http').ServerResponse;
}

function makeReq(headers: Record<string, string> = {}): import('node:http').IncomingMessage {
  const emitter = new EventEmitter();
  (emitter as any).headers = headers;
  return emitter as unknown as import('node:http').IncomingMessage;
}

function makeEventBuffer(overrides: { latestId?: number; getEventsSince?: ReturnType<typeof vi.fn> } = {}) {
  return {
    latestId: overrides.latestId ?? 0,
    getEventsSince: overrides.getEventsSince ?? vi.fn(() => []),
    push: vi.fn(),
    capacity: 100,
  };
}

function makeTree(bbOverrides?: Record<string, unknown>) {
  const data: Record<string, unknown> = bbOverrides ?? { foo: 'bar' };
  return {
    root: { id: 'root', name: 'root', children: [] },
    blackboard: {
      keys: () => Object.keys(data),
      get: (k: string) => data[k],
    },
  } as unknown as import('../core/behavior-tree.js').BehaviorTree;
}

// ---------- sendSseEvent ----------

describe('sendSseEvent', () => {
  it('writes correct SSE wire format', () => {
    const res = makeRes();
    sendSseEvent(res, 'snapshot', { hello: 'world' }, 42);

    expect(res.write).toHaveBeenCalledTimes(3);
    expect(res.write).toHaveBeenNthCalledWith(1, 'id: 42\n');
    expect(res.write).toHaveBeenNthCalledWith(2, 'event: snapshot\n');
    expect(res.write).toHaveBeenNthCalledWith(3, 'data: {"hello":"world"}\n\n');
  });
});

// ---------- blackboardToRecord ----------

describe('blackboardToRecord', () => {
  it('uses toRecord() when available', () => {
    const expected = { a: 1, b: 2 };
    const bb = {
      keys: () => [],
      get: () => undefined,
      toRecord: () => expected,
    };
    expect(blackboardToRecord(bb)).toBe(expected);
  });

  it('falls back to keys()/get() when toRecord is absent', () => {
    const bb = {
      keys: () => ['x', 'y'],
      get: (k: string) => (k === 'x' ? 10 : 20),
    };
    expect(blackboardToRecord(bb)).toEqual({ x: 10, y: 20 });
  });
});

// ---------- broadcastSseEvent ----------

describe('broadcastSseEvent', () => {
  it('sends event to all clients in set', () => {
    const clients = new Set([makeRes(), makeRes(), makeRes()]);
    const entry = { id: 5, event: 'update', data: { key: 'val' }, ts: new Date().toISOString() };

    broadcastSseEvent(clients, entry);

    for (const c of clients) {
      expect(c.write).toHaveBeenCalledTimes(3);
      expect(c.write).toHaveBeenNthCalledWith(1, 'id: 5\n');
    }
  });

  it('with empty set is a no-op', () => {
    const clients = new Set<import('node:http').ServerResponse>();
    const entry = { id: 1, event: 'update', data: {}, ts: new Date().toISOString() };

    // Should not throw
    broadcastSseEvent(clients, entry);
    expect(clients.size).toBe(0);
  });
});

// ---------- handleSseStream ----------

describe('handleSseStream', () => {
  let res: ReturnType<typeof makeRes>;
  let req: ReturnType<typeof makeReq>;
  let tree: ReturnType<typeof makeTree>;
  let sseClients: Set<import('./sse-handler.js').SseClient>;

  beforeEach(() => {
    res = makeRes();
    req = makeReq();
    tree = makeTree();
    sseClients = new Set();
  });

  it('sets SSE response headers', () => {
    const buf = makeEventBuffer();
    handleSseStream(req, res, tree, buf as any, sseClients);

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
  });

  it('sends initial snapshot', () => {
    const buf = makeEventBuffer({ latestId: 7 });
    handleSseStream(req, res, tree, buf as any, sseClients);

    // First write call is the id line of the snapshot event
    expect(res.write).toHaveBeenNthCalledWith(1, 'id: 7\n');
    expect(res.write).toHaveBeenNthCalledWith(2, 'event: snapshot\n');
    // data line contains serialized tree and blackboard
    const dataArg = (res.write as any).mock.calls[2][0] as string;
    expect(dataArg).toMatch(/^data: /);
    const parsed = JSON.parse(dataArg.replace('data: ', '').trim());
    expect(parsed).toHaveProperty('tree');
    expect(parsed).toHaveProperty('blackboard');
    expect(parsed.blackboard).toEqual({ foo: 'bar' });
  });

  it('replays missed events on reconnect (Last-Event-ID)', () => {
    const missed = [
      { id: 3, event: 'update', data: { a: 1 }, ts: '' },
      { id: 4, event: 'update', data: { b: 2 }, ts: '' },
    ];
    const getEventsSince = vi.fn(() => missed);
    const buf = makeEventBuffer({ latestId: 4, getEventsSince });

    req = makeReq({ 'last-event-id': '2' });
    handleSseStream(req, res, tree, buf as any, sseClients);

    expect(getEventsSince).toHaveBeenCalledWith(2);

    // 3 writes for initial snapshot + 3 writes per missed event = 9
    expect(res.write).toHaveBeenCalledTimes(9);
    // The 4th write (first replay event id line)
    expect(res.write).toHaveBeenNthCalledWith(4, 'id: 3\n');
    expect(res.write).toHaveBeenNthCalledWith(7, 'id: 4\n');
  });

  it('sends full snapshot on buffer gap', () => {
    const getEventsSince = vi.fn(() => null);
    const buf = makeEventBuffer({ latestId: 10, getEventsSince });

    req = makeReq({ 'last-event-id': '1' });
    handleSseStream(req, res, tree, buf as any, sseClients);

    expect(getEventsSince).toHaveBeenCalledWith(1);

    // 3 writes for initial snapshot + 3 writes for gap snapshot = 6
    expect(res.write).toHaveBeenCalledTimes(6);
    // Both snapshots should have id: 10
    expect(res.write).toHaveBeenNthCalledWith(1, 'id: 10\n');
    expect(res.write).toHaveBeenNthCalledWith(4, 'id: 10\n');
  });

  it('does not replay when Last-Event-ID header is absent', () => {
    const getEventsSince = vi.fn();
    const buf = makeEventBuffer({ latestId: 5, getEventsSince });

    handleSseStream(req, res, tree, buf as any, sseClients);

    expect(getEventsSince).not.toHaveBeenCalled();
    // Only the initial snapshot: 3 writes
    expect(res.write).toHaveBeenCalledTimes(3);
  });

  it('adds client to sseClients set', () => {
    const buf = makeEventBuffer();
    handleSseStream(req, res, tree, buf as any, sseClients);

    expect(sseClients.has(res)).toBe(true);
    expect(sseClients.size).toBe(1);
  });

  it('removes client from sseClients set on request close', () => {
    const buf = makeEventBuffer();
    handleSseStream(req, res, tree, buf as any, sseClients);

    expect(sseClients.has(res)).toBe(true);

    // Simulate client disconnect
    req.emit('close');

    expect(sseClients.has(res)).toBe(false);
    expect(sseClients.size).toBe(0);
  });
});
