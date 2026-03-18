import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCartographerClient } from './index.js';

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

describe('requireConnection guard', () => {
  it('actionAndWait throws when connect() has not been called', async () => {
    const client = createCartographerClient('http://localhost:3000');
    await expect(client.actionAndWait('doSomething')).rejects.toThrow(
      'SSE connection required: call connect() before using actionAndWait or interruptAndAction'
    );
  });

  it('interruptAndAction throws when connect() has not been called and interrupt() returns interrupted: true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ interrupted: true, messageId: 'x' }),
      status: 200,
    }));

    const client = createCartographerClient('http://localhost:3000');

    await expect(client.interruptAndAction('doSomething')).rejects.toThrow(
      'SSE connection required: call connect() before using actionAndWait or interruptAndAction'
    );
  });

  it('interruptAndAction does NOT throw when interrupt() returns interrupted: false', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        // interrupt() response
        json: () => Promise.resolve({ interrupted: false }),
        status: 200,
      })
      .mockResolvedValueOnce({
        // action() / post() response
        json: () => Promise.resolve({ id: 'msg-1' }),
        status: 200,
      })
    );

    const client = createCartographerClient('http://localhost:3000');

    // Should not throw — falls through to this.action() which calls fetch
    const result = await client.interruptAndAction('doSomething');
    expect(result).toEqual({ id: 'msg-1' });
  });
});
