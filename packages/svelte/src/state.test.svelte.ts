import { describe, it, expect } from 'vitest';
import { CartographerState } from './state.svelte.js';
import { createMockClient } from './test-utils.svelte.js';

describe('CartographerState', () => {
  it('has correct initial state', () => {
    const state = new CartographerState();
    expect(state.connectionStatus).toBe('connecting');
    expect(state.blackboardEntries).toEqual({});
    expect(state.blackboardVersions).toEqual({});
    expect(state.globalVersion).toBe(0);
    expect(state.treeStatus).toBeNull();
  });

  it('populates blackboard from snapshot event', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('snapshot', { blackboard: { name: 'Alice', age: 30 } });

    expect(state.blackboardEntries['name']).toBe('Alice');
    expect(state.blackboardEntries['age']).toBe(30);
  });

  it('sets connectionStatus to connected on snapshot', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    expect(state.connectionStatus).toBe('connecting');
    client.emit('snapshot', { blackboard: {} });
    expect(state.connectionStatus).toBe('connected');
  });

  it('resets version counters on snapshot', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('snapshot', { blackboard: { x: 1 } });
    client.emit('blackboard:write', { key: 'x', value: 2 });
    const versionAfterWrite = state.blackboardVersions['x'];
    expect(versionAfterWrite).toBeGreaterThan(0);

    client.emit('snapshot', { blackboard: { x: 10 } });
    expect(state.blackboardVersions['x']).toBe(1);
  });

  it('updates correct key on blackboard:write', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('snapshot', { blackboard: { a: 1, b: 2 } });
    client.emit('blackboard:write', { key: 'a', value: 99 });

    expect(state.blackboardEntries['a']).toBe(99);
    expect(state.blackboardEntries['b']).toBe(2);
  });

  it('bumps version for written key only', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('snapshot', { blackboard: { a: 1, b: 2 } });
    const versionA = state.blackboardVersions['a'];
    const versionB = state.blackboardVersions['b'];

    client.emit('blackboard:write', { key: 'a', value: 99 });

    expect(state.blackboardVersions['a']).toBe(versionA + 1);
    expect(state.blackboardVersions['b']).toBe(versionB);
  });

  it('bumps globalVersion on blackboard:write', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('snapshot', { blackboard: {} });
    const v0 = state.globalVersion;

    client.emit('blackboard:write', { key: 'x', value: 1 });
    expect(state.globalVersion).toBe(v0 + 1);

    client.emit('blackboard:write', { key: 'y', value: 2 });
    expect(state.globalVersion).toBe(v0 + 2);
  });

  it('updates tree status on tree:tick', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    expect(state.treeStatus).toBeNull();

    client.emit('tree:tick', { tree: 'test', status: 'success', durationMs: 42 });

    expect(state.treeStatus).toEqual({
      status: 'success',
      durationMs: 42,
      localTickCount: 1,
    });
  });

  it('increments localTickCount on each tree:tick', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('tree:tick', { tree: 'test', status: 'success', durationMs: 10 });
    client.emit('tree:tick', { tree: 'test', status: 'running', durationMs: 20 });
    client.emit('tree:tick', { tree: 'test', status: 'failure', durationMs: 30 });

    expect(state.treeStatus!.localTickCount).toBe(3);
    expect(state.treeStatus!.status).toBe('failure');
    expect(state.treeStatus!.durationMs).toBe(30);
  });

  it('resets tree status on new snapshot', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('tree:tick', { tree: 'test', status: 'success', durationMs: 42 });
    expect(state.treeStatus).not.toBeNull();

    client.emit('snapshot', { blackboard: {} });
    expect(state.treeStatus).toBeNull();
  });

  it('sets connectionStatus to connecting on connection:error with readyState 0', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('snapshot', { blackboard: {} });
    expect(state.connectionStatus).toBe('connected');

    client.emit('connection:error', { readyState: 0 });
    expect(state.connectionStatus).toBe('connecting');
  });

  it('sets connectionStatus to disconnected on connection:error with readyState 2', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('snapshot', { blackboard: {} });
    expect(state.connectionStatus).toBe('connected');

    client.emit('connection:error', { readyState: 2 });
    expect(state.connectionStatus).toBe('disconnected');
  });

  it('recovers to connected when snapshot arrives after connection:error', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('snapshot', { blackboard: {} });
    client.emit('connection:error', { readyState: 0 });
    expect(state.connectionStatus).toBe('connecting');

    client.emit('snapshot', { blackboard: { x: 1 } });
    expect(state.connectionStatus).toBe('connected');
  });

  it('detach removes event handlers and sets disconnected', () => {
    const state = new CartographerState();
    const client = createMockClient();
    const detach = state.attach(client);

    client.emit('snapshot', { blackboard: { x: 1 } });
    expect(state.connectionStatus).toBe('connected');

    detach();
    expect(state.connectionStatus).toBe('disconnected');

    // After detach, events should not update state
    client.emit('blackboard:write', { key: 'x', value: 2 });
    expect(state.blackboardEntries['x']).toBe(1);
  });
});
