import { describe, it, expect, vi, afterEach, expectTypeOf } from 'vitest';
import { createCartographerClient, QueueFullError } from './index.js';
import type { CartographerClient } from './types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('connection:error on EventSource error', () => {
  function createMockEventSource() {
    const instance = {
      readyState: 0,
      onerror: null as (() => void) | null,
      addEventListener: vi.fn(),
      close: vi.fn(),
    };
    vi.stubGlobal('EventSource', vi.fn(() => instance));
    return instance;
  }

  it('dispatches connection:error with readyState on EventSource error', () => {
    const mock = createMockEventSource();
    const client = createCartographerClient('http://localhost:3000');
    const handler = vi.fn();
    client.on('connection:error', handler);

    client.connect();
    mock.readyState = 0; // CONNECTING — transient reconnect
    mock.onerror!();

    expect(handler).toHaveBeenCalledWith({ readyState: 0 });
  });

  it('dispatches connection:error with readyState 2 when CLOSED', () => {
    const mock = createMockEventSource();
    const client = createCartographerClient('http://localhost:3000');
    const handler = vi.fn();
    client.on('connection:error', handler);

    client.connect();
    mock.readyState = 2; // CLOSED — permanently dead
    mock.onerror!();

    expect(handler).toHaveBeenCalledWith({ readyState: 2 });
  });
});

describe('SSE event forwarding', () => {
  function createMockEventSource() {
    const handlers = new Map<string, (e: any) => void>();
    const instance = {
      readyState: 1,
      onerror: null as (() => void) | null,
      addEventListener: vi.fn((type: string, handler: (e: any) => void) => {
        handlers.set(type, handler);
      }),
      close: vi.fn(),
      _emit(type: string, data: unknown) {
        const handler = handlers.get(type);
        if (handler) handler({ data: JSON.stringify(data) });
      },
    };
    vi.stubGlobal('EventSource', vi.fn(() => instance));
    return instance;
  }

  const ALL_EVENT_TYPES = [
    'snapshot',
    'blackboard:write', 'client:event', 'message:processed',
    'message:interrupted', 'message:failed', 'message:queued',
    'message:dequeued', 'node:enter', 'node:exit', 'tree:tick',
    'node:error', 'tree:init', 'tree:reset', 'tree:abort', 'tree:tick:skipped',
    'agent:prompt', 'agent:thinking', 'agent:text', 'agent:tool_use', 'agent:response',
    'agent:error', 'agent:message', 'agent:tool_progress', 'agent:init', 'agent:status',
    'agent:rate_limit', 'agent:elicitation_declined',
    'blackboard:keys', 'blackboard:read', 'strategy:decision',
  ];

  it('registers listeners for all event types', () => {
    const mock = createMockEventSource();
    const client = createCartographerClient('http://localhost:3000');
    client.connect();

    const registeredTypes = mock.addEventListener.mock.calls.map((c: any) => c[0]);
    for (const type of ALL_EVENT_TYPES) {
      expect(registeredTypes).toContain(type);
    }
  });

  it('dispatches each event type to on() handlers', () => {
    const mock = createMockEventSource();
    const client = createCartographerClient('http://localhost:3000');

    const received: Array<{ event: string; data: unknown }> = [];
    for (const type of ALL_EVENT_TYPES) {
      client.on(type, (data) => received.push({ event: type, data }));
    }

    client.connect();

    for (const type of ALL_EVENT_TYPES) {
      mock._emit(type, { type });
    }

    expect(received).toHaveLength(ALL_EVENT_TYPES.length);
    for (const type of ALL_EVENT_TYPES) {
      expect(received.find(r => r.event === type)).toBeDefined();
    }
  });

  it('dispatches each event type to onAny() handler', () => {
    const mock = createMockEventSource();
    const client = createCartographerClient('http://localhost:3000');

    const received: Array<{ event: string; data: unknown }> = [];
    client.onAny((event, data) => received.push({ event, data }));

    client.connect();

    for (const type of ALL_EVENT_TYPES) {
      mock._emit(type, { type });
    }

    expect(received).toHaveLength(ALL_EVENT_TYPES.length);
    for (const type of ALL_EVENT_TYPES) {
      expect(received.find(r => r.event === type)).toBeDefined();
    }
  });
});

describe('requireConnection guard', () => {
  it('commandAndWait throws when connect() has not been called', async () => {
    const client = createCartographerClient('http://localhost:3000');
    await expect(client.commandAndWait('doSomething')).rejects.toThrow(
      'SSE connection required: call connect() before using commandAndWait or interruptAndCommand'
    );
  });

  it('interruptAndCommand throws when connect() has not been called and interrupt() returns interrupted: true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ interrupted: true, messageId: 'x' }),
      status: 200,
    }));

    const client = createCartographerClient('http://localhost:3000');

    await expect(client.interruptAndCommand('doSomething')).rejects.toThrow(
      'SSE connection required: call connect() before using commandAndWait or interruptAndCommand'
    );
  });

  it('interruptAndCommand does NOT throw when interrupt() returns interrupted: false (no queue full)', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        // interrupt() response
        json: () => Promise.resolve({ interrupted: false }),
        status: 200,
      })
      .mockResolvedValueOnce({
        // command() / post() response
        json: () => Promise.resolve({ id: 'msg-1' }),
        status: 200,
      })
    );

    const client = createCartographerClient('http://localhost:3000');

    // Should not throw — falls through to this.command() which calls fetch
    const result = await client.interruptAndCommand('doSomething');
    expect(result).toEqual({ id: 'msg-1' });
  });
});

describe('QueueFullError', () => {
  it('has correct name and message', () => {
    const err = new QueueFullError();
    expect(err.name).toBe('QueueFullError');
    expect(err.message).toBe('Server message queue is full');
    expect(err).toBeInstanceOf(Error);
  });

  it('post() throws QueueFullError on 429', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 429,
      json: () => Promise.resolve({}),
    }));

    const client = createCartographerClient('http://localhost:3000');
    await expect(client.command('test')).rejects.toThrow(QueueFullError);
  });
});

describe('createCartographerClient — credentials', () => {
  it('passes credentials to fetch when configured', async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ id: 'msg-1', status: 'processing' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const client = createCartographerClient('http://localhost:3000', {
      credentials: 'include',
    });
    await client.command('test', {});

    expect(capturedInit?.credentials).toBe('include');
  });

  it('defaults credentials to same-origin', async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ id: 'msg-1', status: 'processing' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const client = createCartographerClient('http://localhost:3000');
    await client.command('test', {});

    expect(capturedInit?.credentials).toBe('same-origin');
  });

  it('passes credentials to GET requests', async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const client = createCartographerClient('http://localhost:3000', {
      credentials: 'include',
    });
    await client.blackboard();

    expect(capturedInit?.credentials).toBe('include');
  });
});

describe('CartographerClient - type-level', () => {
  it('command() accepts a generic payload type', () => {
    const client = {} as CartographerClient;
    // When called with a typed payload, T is inferred
    expectTypeOf(client.command<{ item: string }>).parameter(1).toEqualTypeOf<{ item: string } | undefined>();
  });

  it('commandAndWait() accepts a generic payload type', () => {
    const client = {} as CartographerClient;
    expectTypeOf(client.commandAndWait<{ item: string }>).parameter(1).toEqualTypeOf<{ item: string } | undefined>();
  });

  it('interruptAndCommand() accepts a generic payload type', () => {
    const client = {} as CartographerClient;
    expectTypeOf(client.interruptAndCommand<{ item: string }>).parameter(1).toEqualTypeOf<{ item: string } | undefined>();
  });
});
