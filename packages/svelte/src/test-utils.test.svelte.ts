import { describe, it, expect, vi } from 'vitest';
import { createMockClient, createTestContext } from './test-utils.svelte.js';

describe('createMockClient', () => {
  it('has all CartographerClient methods', () => {
    const client = createMockClient();
    expect(client.command).toBeDefined();
    expect(client.write).toBeDefined();
    expect(client.send).toBeDefined();
    expect(client.commandAndWait).toBeDefined();
    expect(client.interrupt).toBeDefined();
    expect(client.resume).toBeDefined();
    expect(client.interruptAndCommand).toBeDefined();
    expect(client.blackboard).toBeDefined();
    expect(client.tree).toBeDefined();
    expect(client.status).toBeDefined();
    expect(client.on).toBeDefined();
    expect(client.onAny).toBeDefined();
    expect(client.off).toBeDefined();
    expect(client.connect).toBeDefined();
    expect(client.disconnect).toBeDefined();
  });

  it('emit dispatches to registered listeners', () => {
    const client = createMockClient();
    const handler = vi.fn();
    client.on('test-event', handler);
    client.emit('test-event', { foo: 'bar' });
    expect(handler).toHaveBeenCalledWith({ foo: 'bar' });
  });

  it('off removes a listener', () => {
    const client = createMockClient();
    const handler = vi.fn();
    client.on('test-event', handler);
    client.off('test-event', handler);
    client.emit('test-event', { foo: 'bar' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('command returns default mock response', async () => {
    const client = createMockClient();
    const result = await client.command('test');
    expect(result).toEqual({ id: 'msg-1' });
  });
});

describe('createTestContext', () => {
  it('returns a wired client and state', () => {
    const { client, state } = createTestContext();
    client.emit('snapshot', { blackboard: { x: 1 } });
    expect(state.blackboardEntries['x']).toBe(1);
    expect(state.connectionStatus).toBe('connected');
  });

  it('accepts overrides', async () => {
    const customCommand = vi.fn().mockResolvedValue({ id: 'custom' });
    const { client } = createTestContext({ command: customCommand });
    const result = await client.command('test');
    expect(result.id).toBe('custom');
  });
});
