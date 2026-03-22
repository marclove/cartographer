import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import CommandTest from './__tests__/CommandTest.svelte';
import { createMockClient } from './test-utils.svelte.js';
import type { CommandRef } from './command.svelte.js';

function renderCommand(
  clientOverrides?: Record<string, unknown>,
): { client: ReturnType<typeof createMockClient>; command: CommandRef } {
  const client = createMockClient();
  if (clientOverrides) {
    Object.assign(client, clientOverrides);
  }

  let command!: CommandRef;
  render(CommandTest, {
    props: {
      client,
      commandName: 'submit',
      onCommand: (a: CommandRef) => {
        command = a;
      },
    },
  });

  return { client, command };
}

describe('createCommand', () => {
  it('send() calls client.command with correct args', async () => {
    const { client, command } = renderCommand();

    await command.send({ rating: 5 });
    await tick();

    expect(client.command).toHaveBeenCalledWith('submit', { rating: 5 });
  });

  it('send() resolves with id', async () => {
    const { command } = renderCommand();

    const result = await command.send();
    expect(result.id).toBe('msg-1');
  });

  it('pending is false initially', () => {
    const { command } = renderCommand();
    expect(command.pending).toBe(false);
  });

  it('pending becomes true after send and false after message:processed', async () => {
    const { client, command } = renderCommand();

    await command.send();
    await tick();

    expect(command.pending).toBe(true);

    client.emit('message:processed', { messageId: 'msg-1', treeStatus: 'success' });
    await tick();

    expect(command.pending).toBe(false);
  });

  it('pending becomes false on message:failed', async () => {
    const { client, command } = renderCommand();

    await command.send();
    await tick();

    client.emit('message:failed', { messageId: 'msg-1', error: 'oops' });
    await tick();

    expect(command.pending).toBe(false);
  });

  it('ignores message:processed for different ID', async () => {
    const { client, command } = renderCommand();

    await command.send();
    await tick();

    client.emit('message:processed', { messageId: 'other-id', treeStatus: 'success' });
    await tick();

    expect(command.pending).toBe(true);
  });

  it('pending stays true until all concurrent sends are resolved', async () => {
    const client = createMockClient();
    (client.command as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'msg-1' })
      .mockResolvedValueOnce({ id: 'msg-2' });

    let command!: CommandRef;
    render(CommandTest, {
      props: {
        client,
        commandName: 'submit',
        onCommand: (a: CommandRef) => {
          command = a;
        },
      },
    });

    await Promise.all([command.send(), command.send()]);
    await tick();

    expect(command.pending).toBe(true);

    client.emit('message:processed', { messageId: 'msg-1', treeStatus: 'success' });
    await tick();

    expect(command.pending).toBe(true);

    client.emit('message:processed', { messageId: 'msg-2', treeStatus: 'success' });
    await tick();

    expect(command.pending).toBe(false);
  });

  it('pending clears correctly when one of two concurrent sends fails via HTTP', async () => {
    const client = createMockClient();
    (client.command as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('500'))
      .mockResolvedValueOnce({ id: 'msg-2' });

    let command!: CommandRef;
    render(CommandTest, {
      props: {
        client,
        commandName: 'submit',
        onCommand: (a: CommandRef) => {
          command = a;
        },
      },
    });

    await Promise.allSettled([command.send(), command.send()]);
    await tick();

    expect(command.pending).toBe(true);

    client.emit('message:processed', { messageId: 'msg-2', treeStatus: 'success' });
    await tick();

    expect(command.pending).toBe(false);
  });

  it('send() resets pending on HTTP error', async () => {
    const client = createMockClient();
    (client.command as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('409'));

    let command!: CommandRef;
    render(CommandTest, {
      props: {
        client,
        commandName: 'submit',
        onCommand: (a: CommandRef) => {
          command = a;
        },
      },
    });

    await expect(command.send()).rejects.toThrow('409');
    await tick();

    expect(command.pending).toBe(false);
  });

  // sendAndWait tests need two ticks before emitting SSE events.
  // sendAndWait is async and hits two awaits before the resolver is
  // registered: `await submitCommand()` → `await client.command()`.
  // Each await yields a microtask. A single `await tick()` only
  // flushes one, so the resolver wouldn't exist yet when we call
  // `client.emit(...)`. The second tick ensures the full chain has
  // settled and the resolver is in place.

  it('sendAndWait calls client.command and resolves on message:processed', async () => {
    const { client, command } = renderCommand();

    const waitPromise = command.sendAndWait({ data: 1 });
    await tick();
    await tick();

    expect(client.command).toHaveBeenCalledWith('submit', { data: 1 });
    expect(command.pending).toBe(true);

    client.emit('message:processed', { messageId: 'msg-1', treeStatus: 'success' });
    const result = await waitPromise;
    await tick();

    expect(result).toEqual({ messageId: 'msg-1', treeStatus: 'success' });
    expect(command.pending).toBe(false);
  });

  it('sendAndWait rejects on message:failed', async () => {
    const { client, command } = renderCommand();

    const waitPromise = command.sendAndWait();
    await tick();
    await tick();

    client.emit('message:failed', { messageId: 'msg-1', error: 'boom' });
    await expect(waitPromise).rejects.toThrow('boom');
    await tick();

    expect(command.pending).toBe(false);
  });

  it('sendAndWait does not clear pending while send() is still awaiting completion', async () => {
    const client = createMockClient();
    (client.command as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'msg-send' })
      .mockResolvedValueOnce({ id: 'msg-wait' });

    let command!: CommandRef;
    render(CommandTest, {
      props: {
        client,
        commandName: 'submit',
        onCommand: (a: CommandRef) => { command = a; },
      },
    });

    // Fire send() — pending because it's awaiting message:processed
    await command.send();
    await tick();
    expect(command.pending).toBe(true);

    // Fire sendAndWait() concurrently — both tracked by ID
    const waitPromise = command.sendAndWait();
    await tick();
    await tick();

    // Resolve sendAndWait via SSE — but send() is still pending
    client.emit('message:processed', { messageId: 'msg-wait', treeStatus: 'success' });
    await waitPromise;
    await tick();

    // pending should still be true because send()'s ID hasn't been resolved
    expect(command.pending).toBe(true);

    // Now resolve the send()
    client.emit('message:processed', { messageId: 'msg-send', treeStatus: 'success' });
    await tick();

    expect(command.pending).toBe(false);
  });
});
