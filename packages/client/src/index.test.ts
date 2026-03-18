import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCartographerClient } from './index.js';

afterEach(() => {
  vi.unstubAllGlobals();
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
