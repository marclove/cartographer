import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { CartographerProvider } from './provider.js';
import { useBlackboard, useBlackboardSnapshot, useTreeStatus, useAction, useClientEvent, useTreeEvent } from './hooks.js';
import { createMockClient } from './test-utils.js';

function wrapper(client: ReturnType<typeof createMockClient>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <CartographerProvider url="http://localhost:3148" client={client}>
        {children}
      </CartographerProvider>
    );
  };
}

// ─── useBlackboard ───

describe('useBlackboard', () => {
  it('returns undefined for unset key before snapshot', () => {
    const client = createMockClient();
    const { result } = renderHook(() => useBlackboard('name'), { wrapper: wrapper(client) });
    expect(result.current[0]).toBeUndefined();
  });

  it('returns value after snapshot', () => {
    const client = createMockClient();
    const { result } = renderHook(() => useBlackboard<string>('name'), { wrapper: wrapper(client) });

    act(() => client.emit('snapshot', { blackboard: { name: 'Alice' } }));

    expect(result.current[0]).toBe('Alice');
  });

  it('updates on blackboard:write for matching key', () => {
    const client = createMockClient();
    const { result } = renderHook(() => useBlackboard<number>('count'), { wrapper: wrapper(client) });

    act(() => client.emit('snapshot', { blackboard: { count: 0 } }));
    expect(result.current[0]).toBe(0);

    act(() => client.emit('blackboard:write', { key: 'count', value: 42 }));
    expect(result.current[0]).toBe(42);
  });

  it('setter calls client.write with correct args', async () => {
    const client = createMockClient();
    const { result } = renderHook(() => useBlackboard<string>('name'), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current[1]('Bob');
    });

    expect(client.write).toHaveBeenCalledWith('name', 'Bob');
  });

  it('setter propagates rejection', async () => {
    const client = createMockClient();
    (client.write as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));

    const { result } = renderHook(() => useBlackboard('x'), { wrapper: wrapper(client) });

    await expect(
      act(async () => {
        await result.current[1]('bad');
      }),
    ).rejects.toThrow('fail');
  });
});

// ─── useBlackboardSnapshot ───

describe('useBlackboardSnapshot', () => {
  it('returns empty object before snapshot', () => {
    const client = createMockClient();
    const { result } = renderHook(() => useBlackboardSnapshot(), { wrapper: wrapper(client) });
    expect(result.current).toEqual({});
  });

  it('returns full blackboard after snapshot', () => {
    const client = createMockClient();
    const { result } = renderHook(() => useBlackboardSnapshot(), { wrapper: wrapper(client) });

    act(() => client.emit('snapshot', { blackboard: { a: 1, b: 2 } }));

    expect(result.current).toEqual({ a: 1, b: 2 });
  });

  it('updates on any key change', () => {
    const client = createMockClient();
    const { result } = renderHook(() => useBlackboardSnapshot(), { wrapper: wrapper(client) });

    act(() => client.emit('snapshot', { blackboard: { x: 1 } }));
    act(() => client.emit('blackboard:write', { key: 'y', value: 2 }));

    expect(result.current).toEqual({ x: 1, y: 2 });
  });
});

// ─── useTreeStatus ───

describe('useTreeStatus', () => {
  it('returns null before first tree:tick', () => {
    const client = createMockClient();
    const { result } = renderHook(() => useTreeStatus(), { wrapper: wrapper(client) });
    expect(result.current).toBeNull();
  });

  it('returns status after tree:tick', () => {
    const client = createMockClient();
    const { result } = renderHook(() => useTreeStatus(), { wrapper: wrapper(client) });

    act(() => client.emit('tree:tick', { tree: 'test', status: 'success', durationMs: 42 }));

    expect(result.current).toEqual({ status: 'success', durationMs: 42, localTickCount: 1 });
  });

  it('increments localTickCount', () => {
    const client = createMockClient();
    const { result } = renderHook(() => useTreeStatus(), { wrapper: wrapper(client) });

    act(() => {
      client.emit('tree:tick', { tree: 'test', status: 'success', durationMs: 10 });
      client.emit('tree:tick', { tree: 'test', status: 'running', durationMs: 20 });
    });

    expect(result.current!.localTickCount).toBe(2);
  });

  it('resets on snapshot', () => {
    const client = createMockClient();
    const { result } = renderHook(() => useTreeStatus(), { wrapper: wrapper(client) });

    act(() => client.emit('tree:tick', { tree: 'test', status: 'success', durationMs: 10 }));
    act(() => client.emit('snapshot', { blackboard: {} }));

    expect(result.current).toBeNull();
  });
});

// ─── useAction ───

describe('useAction', () => {
  it('send() calls client.action with correct args', async () => {
    const client = createMockClient();
    const { result } = renderHook(() => useAction('submit'), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.send({ rating: 5 });
    });

    expect(client.action).toHaveBeenCalledWith('submit', { rating: 5 });
  });

  it('send() resolves with id', async () => {
    const client = createMockClient();
    const { result } = renderHook(() => useAction('submit'), { wrapper: wrapper(client) });

    let response: { id: string } | undefined;
    await act(async () => {
      response = await result.current.send();
    });

    expect(response!.id).toBe('msg-1');
  });

  it('pending is false initially', () => {
    const client = createMockClient();
    const { result } = renderHook(() => useAction('submit'), { wrapper: wrapper(client) });
    expect(result.current.pending).toBe(false);
  });

  it('pending becomes true after send and false after message:processed', async () => {
    const client = createMockClient();
    const { result } = renderHook(() => useAction('submit'), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.send();
    });

    expect(result.current.pending).toBe(true);

    act(() => {
      client.emit('message:processed', { messageId: 'msg-1', treeStatus: 'success' });
    });

    expect(result.current.pending).toBe(false);
  });

  it('pending becomes false on message:failed', async () => {
    const client = createMockClient();
    const { result } = renderHook(() => useAction('submit'), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.send();
    });

    act(() => {
      client.emit('message:failed', { messageId: 'msg-1', error: 'oops' });
    });

    expect(result.current.pending).toBe(false);
  });

  it('ignores message:processed for different ID', async () => {
    const client = createMockClient();
    const { result } = renderHook(() => useAction('submit'), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.send();
    });

    act(() => {
      client.emit('message:processed', { messageId: 'other-id', treeStatus: 'success' });
    });

    expect(result.current.pending).toBe(true);
  });

  it('sendAndWait calls client.actionAndWait', async () => {
    const client = createMockClient();
    const { result } = renderHook(() => useAction('submit'), { wrapper: wrapper(client) });

    let response: { messageId: string; treeStatus: string } | undefined;
    await act(async () => {
      response = await result.current.sendAndWait({ data: 1 });
    });

    expect(client.actionAndWait).toHaveBeenCalledWith('submit', { data: 1 });
    expect(response!.treeStatus).toBe('success');
    expect(result.current.pending).toBe(false);
  });
});

// ─── useClientEvent ───

describe('useClientEvent', () => {
  it('calls handler when matching event fires', () => {
    const client = createMockClient();
    const handler = vi.fn();
    renderHook(() => useClientEvent('ui:modal', handler), { wrapper: wrapper(client) });

    act(() => client.emit('ui:modal', { title: 'Hello' }));

    expect(handler).toHaveBeenCalledWith({ title: 'Hello' });
  });

  it('cleans up on unmount', () => {
    const client = createMockClient();
    const handler = vi.fn();
    const { unmount } = renderHook(() => useClientEvent('ui:modal', handler), { wrapper: wrapper(client) });

    unmount();
    act(() => client.emit('ui:modal', { title: 'After unmount' }));

    expect(handler).not.toHaveBeenCalled();
  });

  it('uses latest handler ref', () => {
    const client = createMockClient();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    const { rerender } = renderHook(
      ({ handler }) => useClientEvent('ui:modal', handler),
      { wrapper: wrapper(client), initialProps: { handler: handler1 } },
    );

    rerender({ handler: handler2 });
    act(() => client.emit('ui:modal', { x: 1 }));

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledWith({ x: 1 });
  });
});

// ─── useTreeEvent ───

describe('useTreeEvent', () => {
  it('calls handler when matching event fires', () => {
    const client = createMockClient();
    const handler = vi.fn();
    renderHook(() => useTreeEvent('node:enter', handler), { wrapper: wrapper(client) });

    act(() => client.emit('node:enter', { node: 'a' }));

    expect(handler).toHaveBeenCalledWith({ node: 'a' });
  });

  it('cleans up on unmount', () => {
    const client = createMockClient();
    const handler = vi.fn();
    const { unmount } = renderHook(() => useTreeEvent('node:enter', handler), { wrapper: wrapper(client) });

    unmount();
    act(() => client.emit('node:enter', { node: 'a' }));

    expect(handler).not.toHaveBeenCalled();
  });
});
