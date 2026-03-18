import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import ActionTest from './__tests__/ActionTest.svelte';
import { createMockClient } from './test-utils.svelte.js';
import type { ActionRef } from './action.svelte.js';

function renderAction(
  clientOverrides?: Record<string, unknown>,
): { client: ReturnType<typeof createMockClient>; action: ActionRef } {
  const client = createMockClient();
  if (clientOverrides) {
    Object.assign(client, clientOverrides);
  }

  let action!: ActionRef;
  render(ActionTest, {
    props: {
      client,
      actionName: 'submit',
      onAction: (a: ActionRef) => {
        action = a;
      },
    },
  });

  return { client, action };
}

describe('createAction', () => {
  it('send() calls client.action with correct args', async () => {
    const { client, action } = renderAction();

    await action.send({ rating: 5 });
    await tick();

    expect(client.action).toHaveBeenCalledWith('submit', { rating: 5 });
  });

  it('send() resolves with id', async () => {
    const { action } = renderAction();

    const result = await action.send();
    expect(result.id).toBe('msg-1');
  });

  it('pending is false initially', () => {
    const { action } = renderAction();
    expect(action.pending).toBe(false);
  });

  it('pending becomes true after send and false after message:processed', async () => {
    const { client, action } = renderAction();

    await action.send();
    await tick();

    expect(action.pending).toBe(true);

    client.emit('message:processed', { messageId: 'msg-1', treeStatus: 'success' });
    await tick();

    expect(action.pending).toBe(false);
  });

  it('pending becomes false on message:failed', async () => {
    const { client, action } = renderAction();

    await action.send();
    await tick();

    client.emit('message:failed', { messageId: 'msg-1', error: 'oops' });
    await tick();

    expect(action.pending).toBe(false);
  });

  it('ignores message:processed for different ID', async () => {
    const { client, action } = renderAction();

    await action.send();
    await tick();

    client.emit('message:processed', { messageId: 'other-id', treeStatus: 'success' });
    await tick();

    expect(action.pending).toBe(true);
  });

  it('pending stays true until all concurrent sends are resolved', async () => {
    const client = createMockClient();
    (client.action as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'msg-1' })
      .mockResolvedValueOnce({ id: 'msg-2' });

    let action!: ActionRef;
    render(ActionTest, {
      props: {
        client,
        actionName: 'submit',
        onAction: (a: ActionRef) => {
          action = a;
        },
      },
    });

    await Promise.all([action.send(), action.send()]);
    await tick();

    expect(action.pending).toBe(true);

    client.emit('message:processed', { messageId: 'msg-1', treeStatus: 'success' });
    await tick();

    expect(action.pending).toBe(true);

    client.emit('message:processed', { messageId: 'msg-2', treeStatus: 'success' });
    await tick();

    expect(action.pending).toBe(false);
  });

  it('pending clears correctly when one of two concurrent sends fails via HTTP', async () => {
    const client = createMockClient();
    (client.action as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('500'))
      .mockResolvedValueOnce({ id: 'msg-2' });

    let action!: ActionRef;
    render(ActionTest, {
      props: {
        client,
        actionName: 'submit',
        onAction: (a: ActionRef) => {
          action = a;
        },
      },
    });

    await Promise.allSettled([action.send(), action.send()]);
    await tick();

    expect(action.pending).toBe(true);

    client.emit('message:processed', { messageId: 'msg-2', treeStatus: 'success' });
    await tick();

    expect(action.pending).toBe(false);
  });

  it('send() resets pending on HTTP error', async () => {
    const client = createMockClient();
    (client.action as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('409'));

    let action!: ActionRef;
    render(ActionTest, {
      props: {
        client,
        actionName: 'submit',
        onAction: (a: ActionRef) => {
          action = a;
        },
      },
    });

    await expect(action.send()).rejects.toThrow('409');
    await tick();

    expect(action.pending).toBe(false);
  });

  // sendAndWait tests need two ticks before emitting SSE events.
  // sendAndWait is async and hits two awaits before the resolver is
  // registered: `await submitAction()` → `await client.action()`.
  // Each await yields a microtask. A single `await tick()` only
  // flushes one, so the resolver wouldn't exist yet when we call
  // `client.emit(...)`. The second tick ensures the full chain has
  // settled and the resolver is in place.

  it('sendAndWait calls client.action and resolves on message:processed', async () => {
    const { client, action } = renderAction();

    const waitPromise = action.sendAndWait({ data: 1 });
    await tick();
    await tick();

    expect(client.action).toHaveBeenCalledWith('submit', { data: 1 });
    expect(action.pending).toBe(true);

    client.emit('message:processed', { messageId: 'msg-1', treeStatus: 'success' });
    const result = await waitPromise;
    await tick();

    expect(result).toEqual({ messageId: 'msg-1', treeStatus: 'success' });
    expect(action.pending).toBe(false);
  });

  it('sendAndWait rejects on message:failed', async () => {
    const { client, action } = renderAction();

    const waitPromise = action.sendAndWait();
    await tick();
    await tick();

    client.emit('message:failed', { messageId: 'msg-1', error: 'boom' });
    await expect(waitPromise).rejects.toThrow('boom');
    await tick();

    expect(action.pending).toBe(false);
  });

  it('sendAndWait does not clear pending while send() is still awaiting completion', async () => {
    const client = createMockClient();
    (client.action as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'msg-send' })
      .mockResolvedValueOnce({ id: 'msg-wait' });

    let action!: ActionRef;
    render(ActionTest, {
      props: {
        client,
        actionName: 'submit',
        onAction: (a: ActionRef) => { action = a; },
      },
    });

    // Fire send() — pending because it's awaiting message:processed
    await action.send();
    await tick();
    expect(action.pending).toBe(true);

    // Fire sendAndWait() concurrently — both tracked by ID
    const waitPromise = action.sendAndWait();
    await tick();
    await tick();

    // Resolve sendAndWait via SSE — but send() is still pending
    client.emit('message:processed', { messageId: 'msg-wait', treeStatus: 'success' });
    await waitPromise;
    await tick();

    // pending should still be true because send()'s ID hasn't been resolved
    expect(action.pending).toBe(true);

    // Now resolve the send()
    client.emit('message:processed', { messageId: 'msg-send', treeStatus: 'success' });
    await tick();

    expect(action.pending).toBe(false);
  });
});
