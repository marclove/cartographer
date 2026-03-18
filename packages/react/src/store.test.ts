import { describe, it, expect, vi } from 'vitest';
import { createSyncStore } from './store.js';
import { createMockClient } from './test-utils.js';

describe('SyncStore', () => {
  it('returns empty initial state', () => {
    const store = createSyncStore();
    expect(store.getBlackboardSnapshot()).toEqual({});
    expect(store.getTreeStatus()).toBeNull();
    expect(store.getConnectionStatus()).toBe('connecting');
    expect(store.getGlobalVersion()).toBe(0);
  });

  it('populates blackboard from snapshot event', () => {
    const store = createSyncStore();
    const client = createMockClient();
    store.attach(client);

    client.emit('snapshot', { blackboard: { name: 'Alice', age: 30 } });

    expect(store.getBlackboardValue('name')).toBe('Alice');
    expect(store.getBlackboardValue('age')).toBe(30);
    expect(store.getBlackboardSnapshot()).toEqual({ name: 'Alice', age: 30 });
  });

  it('sets connectionStatus to connected on snapshot', () => {
    const store = createSyncStore();
    const client = createMockClient();
    store.attach(client);

    expect(store.getConnectionStatus()).toBe('connecting');
    client.emit('snapshot', { blackboard: {} });
    expect(store.getConnectionStatus()).toBe('connected');
  });

  it('resets version counters on snapshot', () => {
    const store = createSyncStore();
    const client = createMockClient();
    store.attach(client);

    // Write a key to bump its version
    client.emit('snapshot', { blackboard: { x: 1 } });
    client.emit('blackboard:write', { key: 'x', value: 2 });
    const versionAfterWrite = store.getBlackboardVersion('x');
    expect(versionAfterWrite).toBeGreaterThan(0);

    // New snapshot resets
    client.emit('snapshot', { blackboard: { x: 10 } });
    expect(store.getBlackboardVersion('x')).toBe(1);
  });

  it('updates correct key on blackboard:write', () => {
    const store = createSyncStore();
    const client = createMockClient();
    store.attach(client);

    client.emit('snapshot', { blackboard: { a: 1, b: 2 } });
    client.emit('blackboard:write', { key: 'a', value: 99 });

    expect(store.getBlackboardValue('a')).toBe(99);
    expect(store.getBlackboardValue('b')).toBe(2);
  });

  it('bumps version for written key only', () => {
    const store = createSyncStore();
    const client = createMockClient();
    store.attach(client);

    client.emit('snapshot', { blackboard: { a: 1, b: 2 } });
    const versionA = store.getBlackboardVersion('a');
    const versionB = store.getBlackboardVersion('b');

    client.emit('blackboard:write', { key: 'a', value: 99 });

    expect(store.getBlackboardVersion('a')).toBe(versionA + 1);
    expect(store.getBlackboardVersion('b')).toBe(versionB);
  });

  it('bumps globalVersion on blackboard:write', () => {
    const store = createSyncStore();
    const client = createMockClient();
    store.attach(client);

    client.emit('snapshot', { blackboard: {} });
    const v0 = store.getGlobalVersion();

    client.emit('blackboard:write', { key: 'x', value: 1 });
    expect(store.getGlobalVersion()).toBe(v0 + 1);

    client.emit('blackboard:write', { key: 'y', value: 2 });
    expect(store.getGlobalVersion()).toBe(v0 + 2);
  });

  it('updates tree status on tree:tick', () => {
    const store = createSyncStore();
    const client = createMockClient();
    store.attach(client);

    expect(store.getTreeStatus()).toBeNull();

    client.emit('tree:tick', { tree: 'test', status: 'success', durationMs: 42 });

    expect(store.getTreeStatus()).toEqual({
      status: 'success',
      durationMs: 42,
      localTickCount: 1,
    });
  });

  it('increments localTickCount on each tree:tick', () => {
    const store = createSyncStore();
    const client = createMockClient();
    store.attach(client);

    client.emit('tree:tick', { tree: 'test', status: 'success', durationMs: 10 });
    client.emit('tree:tick', { tree: 'test', status: 'running', durationMs: 20 });
    client.emit('tree:tick', { tree: 'test', status: 'failure', durationMs: 30 });

    expect(store.getTreeStatus()!.localTickCount).toBe(3);
    expect(store.getTreeStatus()!.status).toBe('failure');
    expect(store.getTreeStatus()!.durationMs).toBe(30);
  });

  it('resets tree status on new snapshot', () => {
    const store = createSyncStore();
    const client = createMockClient();
    store.attach(client);

    client.emit('tree:tick', { tree: 'test', status: 'success', durationMs: 42 });
    expect(store.getTreeStatus()).not.toBeNull();

    client.emit('snapshot', { blackboard: {} });
    expect(store.getTreeStatus()).toBeNull();
  });

  it('notifies subscribers on state changes', () => {
    const store = createSyncStore();
    const client = createMockClient();
    store.attach(client);

    const listener = vi.fn();
    store.subscribe(listener);

    client.emit('snapshot', { blackboard: { x: 1 } });
    expect(listener).toHaveBeenCalledTimes(1);

    client.emit('blackboard:write', { key: 'x', value: 2 });
    expect(listener).toHaveBeenCalledTimes(2);

    client.emit('tree:tick', { tree: 'test', status: 'success', durationMs: 10 });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('unsubscribe removes the listener', () => {
    const store = createSyncStore();
    const client = createMockClient();
    store.attach(client);

    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    client.emit('snapshot', { blackboard: {} });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();

    client.emit('blackboard:write', { key: 'x', value: 1 });
    expect(listener).toHaveBeenCalledTimes(1); // not called again
  });

  it('attach cleanup removes event handlers', () => {
    const store = createSyncStore();
    const client = createMockClient();
    const detach = store.attach(client);

    const listener = vi.fn();
    store.subscribe(listener);

    client.emit('snapshot', { blackboard: { x: 1 } });
    expect(listener).toHaveBeenCalledTimes(1);

    detach();

    client.emit('blackboard:write', { key: 'x', value: 2 });
    expect(listener).toHaveBeenCalledTimes(2); // called for detach (disconnected), not for write
    expect(store.getBlackboardValue('x')).toBe(1); // value unchanged
  });

  it('sets connectionStatus to disconnected on detach', () => {
    const store = createSyncStore();
    const client = createMockClient();
    const detach = store.attach(client);

    client.emit('snapshot', { blackboard: {} });
    expect(store.getConnectionStatus()).toBe('connected');

    detach();
    expect(store.getConnectionStatus()).toBe('disconnected');
  });
});
