import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  sendSseEvent,
  handleSseStream,
} from './sse-handler.js';
import { blackboardToRecord } from './blackboard-utils.js';
import type { SseSnapshot } from './sse-handler.js';
import { InProcessEventStream } from './event-stream.js';

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

function makeEventStream(overrides: { latestId?: string; replaySince?: ReturnType<typeof vi.fn> } = {}) {
  return {
    latestId: overrides.latestId ?? '0',
    replaySince: overrides.replaySince ?? vi.fn(() => []),
    push: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  };
}

function makeSnapshot(id = '0'): SseSnapshot {
  return {
    data: {
      tree: { id: 'root', name: 'root', type: 'sequence', children: [] },
      blackboard: { foo: 'bar' },
    },
    id,
  };
}

// ---------- sendSseEvent ----------

describe('sendSseEvent', () => {
  it('writes correct SSE wire format', () => {
    const res = makeRes();
    sendSseEvent(res, 'snapshot', { hello: 'world' }, '42');

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

// ---------- handleSseStream ----------

describe('handleSseStream', () => {
  let res: ReturnType<typeof makeRes>;
  let req: ReturnType<typeof makeReq>;
  let snapshot: SseSnapshot;
  let sseClients: Set<import('./sse-handler.js').SseClient>;

  beforeEach(() => {
    res = makeRes();
    req = makeReq();
    snapshot = makeSnapshot();
    sseClients = new Set();
  });

  it('sets SSE response headers', () => {
    const stream = makeEventStream();
    handleSseStream(req, res, snapshot, stream as any, sseClients);

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
  });

  it('sends initial snapshot', () => {
    snapshot = makeSnapshot('7');
    const stream = makeEventStream({ latestId: '7' });
    handleSseStream(req, res, snapshot, stream as any, sseClients);

    expect(res.write).toHaveBeenNthCalledWith(1, 'id: 7\n');
    expect(res.write).toHaveBeenNthCalledWith(2, 'event: snapshot\n');
    const dataArg = (res.write as any).mock.calls[2][0] as string;
    expect(dataArg).toMatch(/^data: /);
    const parsed = JSON.parse(dataArg.replace('data: ', '').trim());
    expect(parsed).toHaveProperty('tree');
    expect(parsed).toHaveProperty('blackboard');
    expect(parsed.blackboard).toEqual({ foo: 'bar' });
  });

  it('replays missed events on reconnect (Last-Event-ID)', () => {
    const missed = [
      { id: '3', event: 'update', data: { a: 1 }, ts: '' },
      { id: '4', event: 'update', data: { b: 2 }, ts: '' },
    ];
    const replaySince = vi.fn(() => missed);
    const stream = makeEventStream({ latestId: '4', replaySince });

    req = makeReq({ 'last-event-id': '2' });
    handleSseStream(req, res, snapshot, stream as any, sseClients);

    expect(replaySince).toHaveBeenCalledWith('2');

    // 3 writes for initial snapshot + 3 writes per missed event = 9
    expect(res.write).toHaveBeenCalledTimes(9);
    expect(res.write).toHaveBeenNthCalledWith(4, 'id: 3\n');
    expect(res.write).toHaveBeenNthCalledWith(7, 'id: 4\n');
  });

  it('sends full snapshot on buffer gap', () => {
    const replaySince = vi.fn(() => null);
    const stream = makeEventStream({ latestId: '10', replaySince });

    snapshot = makeSnapshot('10');
    req = makeReq({ 'last-event-id': '1' });
    handleSseStream(req, res, snapshot, stream as any, sseClients);

    expect(replaySince).toHaveBeenCalledWith('1');

    // 3 writes for initial snapshot + 3 writes for gap snapshot = 6
    expect(res.write).toHaveBeenCalledTimes(6);
    expect(res.write).toHaveBeenNthCalledWith(1, 'id: 10\n');
    expect(res.write).toHaveBeenNthCalledWith(4, 'id: 10\n');
  });

  it('does not replay when Last-Event-ID header is absent', () => {
    const replaySince = vi.fn();
    const stream = makeEventStream({ latestId: '5', replaySince });

    handleSseStream(req, res, snapshot, stream as any, sseClients);

    expect(replaySince).not.toHaveBeenCalled();
    expect(res.write).toHaveBeenCalledTimes(3);
  });

  it('adds client to sseClients set', () => {
    const stream = makeEventStream();
    handleSseStream(req, res, snapshot, stream as any, sseClients);

    expect(sseClients.has(res)).toBe(true);
    expect(sseClients.size).toBe(1);
  });

  it('removes client from sseClients set on request close', () => {
    const stream = makeEventStream();
    handleSseStream(req, res, snapshot, stream as any, sseClients);

    expect(sseClients.has(res)).toBe(true);

    req.emit('close');

    expect(sseClients.has(res)).toBe(false);
    expect(sseClients.size).toBe(0);
  });

  it('subscribes to live events and unsubscribes on close', () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const stream = { ...makeEventStream(), subscribe };

    handleSseStream(req, res, snapshot, stream as any, sseClients);

    expect(subscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).not.toHaveBeenCalled();

    req.emit('close');

    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('forwards live events to the response', () => {
    const stream = new InProcessEventStream(100);
    handleSseStream(req, res, snapshot, stream, sseClients);

    // Clear snapshot writes
    (res.write as any).mockClear();

    stream.push('node:enter', { node: { id: 'a' } });

    expect(res.write).toHaveBeenCalledTimes(3);
    expect(res.write).toHaveBeenNthCalledWith(1, 'id: 1\n');
    expect(res.write).toHaveBeenNthCalledWith(2, 'event: node:enter\n');
  });
});
