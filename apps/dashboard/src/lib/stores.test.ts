import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockClient } from '@cartographer/svelte';
import type { TreeNode } from './types.js';
import {
  DashboardState,
  getEventCategory,
} from './stores.svelte.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockClient = ReturnType<typeof createMockClient>;

const ROOT_NODE: TreeNode = {
  id: 'root',
  name: 'Root',
  type: 'sequence',
  children: [
    { id: 'child-a', name: 'ChildA', type: 'action', children: [] },
    { id: 'child-b', name: 'ChildB', type: 'action', children: [] },
  ],
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    tree: ROOT_NODE,
    blackboard: {},
    ...overrides,
  };
}

function setup() {
  const client = createMockClient();
  const state = new DashboardState();
  const detach = state.wire(client);
  return { client, state, detach };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stores — node status tracking', () => {
  let client: MockClient;
  let state: DashboardState;
  let detach: () => void;

  beforeEach(() => {
    ({ client, state, detach } = setup());
    client.emit('snapshot', snapshot());
  });

  afterEach(() => detach());

  it('snapshot resets all node statuses', () => {
    client.emit('node:enter', { node: { id: 'root', name: 'Root', type: 'sequence' } });
    expect(state.nodeStatuses.get('root')).toBe('running');

    client.emit('snapshot', snapshot());
    expect(state.nodeStatuses.size).toBe(0);
  });

  it('node:enter sets the node status to running', () => {
    client.emit('node:enter', { node: { id: 'child-a', name: 'ChildA', type: 'action' } });
    expect(state.nodeStatuses.get('child-a')).toBe('running');
  });

  it('node:exit sets the node status to the exit status', () => {
    client.emit('node:enter', { node: { id: 'child-a', name: 'ChildA', type: 'action' } });
    client.emit('node:exit', { node: { id: 'child-a', name: 'ChildA', type: 'action' }, status: 'success', durationMs: 1 });
    expect(state.nodeStatuses.get('child-a')).toBe('success');
  });

  it('node:error sets the node status to failure', () => {
    client.emit('node:enter', { node: { id: 'child-b', name: 'ChildB', type: 'action' } });
    client.emit('node:error', { node: { id: 'child-b', name: 'ChildB', type: 'action' }, error: 'boom' });
    expect(state.nodeStatuses.get('child-b')).toBe('failure');
  });

  it('tree:reset clears all node statuses', () => {
    client.emit('node:enter', { node: { id: 'root', name: 'Root', type: 'sequence' } });
    client.emit('tree:reset', {});
    expect(state.nodeStatuses.size).toBe(0);
  });

  it('node:enter for the root clears all statuses from the previous tick', () => {
    client.emit('node:enter', { node: { id: 'root', name: 'Root', type: 'sequence' } });
    client.emit('node:enter', { node: { id: 'child-a', name: 'ChildA', type: 'action' } });
    client.emit('node:exit', { node: { id: 'child-a', name: 'ChildA', type: 'action' }, status: 'success', durationMs: 1 });
    client.emit('node:enter', { node: { id: 'child-b', name: 'ChildB', type: 'action' } });
    client.emit('node:exit', { node: { id: 'child-b', name: 'ChildB', type: 'action' }, status: 'success', durationMs: 1 });
    client.emit('node:exit', { node: { id: 'root', name: 'Root', type: 'sequence' }, status: 'success', durationMs: 5 });
    client.emit('tree:tick', { status: 'success', durationMs: 5 });

    expect(state.nodeStatuses.get('child-a')).toBe('success');
    expect(state.nodeStatuses.get('child-b')).toBe('success');
    expect(state.nodeStatuses.get('root')).toBe('success');

    // New tick starts — root enters
    client.emit('node:enter', { node: { id: 'root', name: 'Root', type: 'sequence' } });

    expect(state.nodeStatuses.get('child-a')).toBeUndefined();
    expect(state.nodeStatuses.get('child-b')).toBeUndefined();
    expect(state.nodeStatuses.get('root')).toBe('running');
  });

  it('node:enter for a non-root node does NOT clear other statuses', () => {
    client.emit('node:enter', { node: { id: 'root', name: 'Root', type: 'sequence' } });
    client.emit('node:enter', { node: { id: 'child-a', name: 'ChildA', type: 'action' } });

    expect(state.nodeStatuses.get('root')).toBe('running');
    expect(state.nodeStatuses.get('child-a')).toBe('running');
  });

  it('statuses accumulate correctly within a single tick', () => {
    client.emit('node:enter', { node: { id: 'root', name: 'Root', type: 'sequence' } });
    client.emit('node:enter', { node: { id: 'child-a', name: 'ChildA', type: 'action' } });
    client.emit('node:exit', { node: { id: 'child-a', name: 'ChildA', type: 'action' }, status: 'success', durationMs: 1 });
    client.emit('node:enter', { node: { id: 'child-b', name: 'ChildB', type: 'action' } });

    expect(state.nodeStatuses.get('root')).toBe('running');
    expect(state.nodeStatuses.get('child-a')).toBe('success');
    expect(state.nodeStatuses.get('child-b')).toBe('running');
  });
});

describe('stores — tree structure', () => {
  let client: MockClient;
  let state: DashboardState;
  let detach: () => void;

  beforeEach(() => {
    ({ client, state, detach } = setup());
  });

  afterEach(() => detach());

  it('snapshot populates tree root and name', () => {
    client.emit('snapshot', snapshot());
    expect(state.treeName).toBe('Root');
    expect(state.treeRoot?.id).toBe('root');
    expect(state.treeRoot?.children).toHaveLength(2);
  });
});

describe('stores — blackboard', () => {
  let client: MockClient;
  let state: DashboardState;
  let detach: () => void;

  beforeEach(() => {
    ({ client, state, detach } = setup());
    client.emit('snapshot', snapshot({ blackboard: { counter: 0 } }));
  });

  afterEach(() => detach());

  it('snapshot sets initial blackboard state', () => {
    expect(state.blackboard).toEqual({ counter: 0 });
  });

  it('blackboard:write updates the blackboard', () => {
    client.emit('blackboard:write', { key: 'counter', value: 1 });
    expect(state.blackboard).toEqual({ counter: 1 });
  });

  it('blackboard:write adds new keys', () => {
    client.emit('blackboard:write', { key: 'result', value: 'done' });
    expect(state.blackboard).toEqual({ counter: 0, result: 'done' });
  });
});

describe('stores — tick stats', () => {
  let client: MockClient;
  let state: DashboardState;
  let detach: () => void;

  beforeEach(() => {
    ({ client, state, detach } = setup());
    client.emit('snapshot', snapshot());
  });

  afterEach(() => detach());

  it('tree:tick increments tick count and records status', () => {
    client.emit('tree:tick', { status: 'success', durationMs: 12 });
    expect(state.tickCount).toBe(1);
    expect(state.lastStatus).toBe('success');

    client.emit('tree:tick', { status: 'failure', durationMs: 5 });
    expect(state.tickCount).toBe(2);
    expect(state.lastStatus).toBe('failure');
  });

  it('tree:tick increments stats after snapshot with non-zero asOfEventId', () => {
    // Simulate a snapshot that includes baseline stats from the server
    client.emit('snapshot', snapshot({
      stats: {
        tickCount: 100,
        cycleCount: 50,
        lastStatus: 'success',
        lastDurationMs: 10,
        asOfEventId: 500,
      },
    }));
    expect(state.tickCount).toBe(100);
    expect(state.cycleCount).toBe(50);

    // New ticks after the snapshot should still increment
    client.emit('tree:tick', { status: 'running', durationMs: 5 });
    expect(state.tickCount).toBe(101);
    expect(state.cycleCount).toBe(50); // running doesn't increment cycle

    client.emit('tree:tick', { status: 'success', durationMs: 10 });
    expect(state.tickCount).toBe(102);
    expect(state.cycleCount).toBe(51);
  });
});

describe('stores — event timeline', () => {
  let client: MockClient;
  let state: DashboardState;
  let detach: () => void;

  beforeEach(() => {
    ({ client, state, detach } = setup());
    client.emit('snapshot', snapshot());
  });

  afterEach(() => detach());

  it('pushes events to the timeline', () => {
    client.emit('node:enter', { node: { id: 'root', name: 'Root', type: 'sequence' } });
    // snapshot (from beforeEach) + node:enter
    expect(state.events).toHaveLength(2);
    expect(state.events[0].event).toBe('snapshot');
    expect(state.events[1].event).toBe('node:enter');
  });

  it('categorizes events correctly', () => {
    client.emit('node:enter', { node: { id: 'root', name: 'Root', type: 'sequence' } });
    client.emit('blackboard:write', { key: 'x', value: 1 });

    expect(state.events[1].category).toBe('nodes');
    expect(state.events[2].category).toBe('blackboard');
  });

  it('caps the event timeline at MAX_EVENTS (2000)', () => {
    for (let i = 0; i < 2001; i++) {
      client.emit('node:enter', { node: { id: 'root', name: 'Root', type: 'sequence' } });
    }
    expect(state.events).toHaveLength(2000);
    expect(state.events[0].id).not.toBe(1);
  });
});

describe('stores — getEventCategory', () => {
  it('maps node events to "nodes"', () => {
    expect(getEventCategory('node:enter')).toBe('nodes');
    expect(getEventCategory('node:exit')).toBe('nodes');
    expect(getEventCategory('node:error')).toBe('nodes');
  });

  it('maps tree events to "nodes"', () => {
    expect(getEventCategory('tree:init')).toBe('nodes');
    expect(getEventCategory('tree:tick')).toBe('nodes');
    expect(getEventCategory('tree:tick:skipped')).toBe('nodes');
    expect(getEventCategory('tree:reset')).toBe('nodes');
    expect(getEventCategory('tree:abort')).toBe('nodes');
  });

  it('maps agent events to "agent"', () => {
    expect(getEventCategory('agent:prompt')).toBe('agent');
    expect(getEventCategory('agent:thinking')).toBe('agent');
    expect(getEventCategory('agent:text')).toBe('agent');
    expect(getEventCategory('agent:tool_use')).toBe('agent');
    expect(getEventCategory('agent:response')).toBe('agent');
    expect(getEventCategory('agent:error')).toBe('agent');
    expect(getEventCategory('agent:message')).toBe('agent');
    expect(getEventCategory('agent:tool_progress')).toBe('agent');
    expect(getEventCategory('agent:init')).toBe('agent');
    expect(getEventCategory('agent:status')).toBe('agent');
    expect(getEventCategory('agent:rate_limit')).toBe('agent');
    expect(getEventCategory('agent:elicitation_declined')).toBe('agent');
  });

  it('maps blackboard:keys to "blackboard"', () => {
    expect(getEventCategory('blackboard:keys')).toBe('blackboard');
  });

  it('maps blackboard:read to "blackboard"', () => {
    expect(getEventCategory('blackboard:read')).toBe('blackboard');
  });

  it('maps blackboard:write to "blackboard"', () => {
    expect(getEventCategory('blackboard:write')).toBe('blackboard');
  });

  it('maps strategy:decision to "strategy"', () => {
    expect(getEventCategory('strategy:decision')).toBe('strategy');
  });

  it('returns "other" for unknown event names', () => {
    expect(getEventCategory('unknown:event')).toBe('other');
    expect(getEventCategory('')).toBe('other');
  });
});

describe('stores — filters', () => {
  let state: DashboardState;
  let detach: () => void;

  beforeEach(() => {
    const s = setup();
    state = s.state;
    detach = s.detach;
  });

  afterEach(() => detach());

  it('all categories are active by default', () => {
    expect(state.activeFilters.has('nodes')).toBe(true);
    expect(state.activeFilters.has('agent')).toBe(true);
    expect(state.activeFilters.has('blackboard')).toBe(true);
    expect(state.activeFilters.has('strategy')).toBe(true);
  });

  it('toggleFilter removes an active filter', () => {
    state.toggleFilter('agent');
    expect(state.activeFilters.has('agent')).toBe(false);
    expect(state.activeFilters.has('nodes')).toBe(true);
  });

  it('toggleFilter re-adds a removed filter', () => {
    state.toggleFilter('agent');
    expect(state.activeFilters.has('agent')).toBe(false);
    state.toggleFilter('agent');
    expect(state.activeFilters.has('agent')).toBe(true);
  });
});

describe('stores — node selection', () => {
  let client: MockClient;
  let state: DashboardState;
  let detach: () => void;

  beforeEach(() => {
    ({ client, state, detach } = setup());
    client.emit('snapshot', snapshot());
  });

  afterEach(() => detach());

  it('initially has no selected node', () => {
    expect(state.selectedNodeId).toBeNull();
    expect(state.nodeDetail).toBeNull();
  });

  it('selectNode sets the selected node id', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ id: 'child-a', name: 'ChildA', type: 'action' }),
    }));
    state.selectNode('child-a');
    expect(state.selectedNodeId).toBe('child-a');
    vi.unstubAllGlobals();
  });

  it('selectNode fetches node detail', async () => {
    const mockDetail = { id: 'child-a', name: 'ChildA', type: 'action' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve(mockDetail),
    }));

    state.selectNode('child-a');
    expect(state.selectedNodeId).toBe('child-a');

    await vi.waitFor(() => {
      expect(state.nodeDetail).toEqual(mockDetail);
    });
    vi.unstubAllGlobals();
  });

  it('selectNode toggles off when called with the same id', () => {
    state.selectNode('child-a');
    expect(state.selectedNodeId).toBe('child-a');
    state.selectNode('child-a');
    expect(state.selectedNodeId).toBeNull();
    expect(state.nodeDetail).toBeNull();
  });

  it('selectNode(null) clears selection', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({}),
    }));
    state.selectNode('child-a');
    state.selectNode(null);
    expect(state.selectedNodeId).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('stores — tick duration', () => {
  let client: MockClient;
  let state: DashboardState;
  let detach: () => void;

  beforeEach(() => {
    ({ client, state, detach } = setup());
    client.emit('snapshot', snapshot());
  });

  afterEach(() => detach());

  it('tree:tick records lastDurationMs', () => {
    expect(state.lastDurationMs).toBeNull();
    client.emit('tree:tick', { status: 'success', durationMs: 42.5 });
    expect(state.lastDurationMs).toBe(42.5);
  });
});

describe('stores — recentlyUpdatedKeys', () => {
  let client: MockClient;
  let state: DashboardState;
  let detach: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    ({ client, state, detach } = setup());
    client.emit('snapshot', snapshot({ blackboard: {} }));
  });

  afterEach(() => {
    vi.useRealTimers();
    detach();
  });

  it('blackboard:write adds key to recentlyUpdatedKeys', () => {
    client.emit('blackboard:write', { key: 'counter', value: 1 });
    expect(state.recentlyUpdatedKeys.has('counter')).toBe(true);
  });

  it('recentlyUpdatedKeys clears after 2 seconds', () => {
    client.emit('blackboard:write', { key: 'counter', value: 1 });
    expect(state.recentlyUpdatedKeys.has('counter')).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(state.recentlyUpdatedKeys.has('counter')).toBe(false);
  });

  it('multiple keys can be highlighted simultaneously', () => {
    client.emit('blackboard:write', { key: 'a', value: 1 });
    client.emit('blackboard:write', { key: 'b', value: 2 });
    expect(state.recentlyUpdatedKeys.has('a')).toBe(true);
    expect(state.recentlyUpdatedKeys.has('b')).toBe(true);
  });

  it('blackboard:keys pushes event to timeline without mutating blackboard', () => {
    client.emit('blackboard:keys', { keys: ['counter'], source: 'blackboard' });
    expect(state.blackboard).toEqual({});
    const keysEvt = state.events.find((e) => e.event === 'blackboard:keys');
    expect(keysEvt).toBeDefined();
    expect(keysEvt!.category).toBe('blackboard');
  });

  it('blackboard:read pushes event to timeline without mutating blackboard', () => {
    client.emit('blackboard:read', { key: 'counter', value: 0, hit: true });
    expect(state.blackboard).toEqual({});
    const readEvt = state.events.find((e) => e.event === 'blackboard:read');
    expect(readEvt).toBeDefined();
    expect(readEvt!.category).toBe('blackboard');
  });

  it('blackboard:write with missing key does not update blackboard', () => {
    client.emit('blackboard:write', { value: 'no-key' });
    expect(state.blackboard).toEqual({});
    expect(state.recentlyUpdatedKeys.size).toBe(0);
  });
});

describe('stores — tree:tick:skipped', () => {
  let client: MockClient;
  let state: DashboardState;
  let detach: () => void;

  beforeEach(() => {
    ({ client, state, detach } = setup());
    client.emit('snapshot', snapshot());
  });

  afterEach(() => detach());

  it('tree:tick:skipped events appear in the timeline with category "nodes"', () => {
    client.emit('tree:tick:skipped', { timestamp: 1234567890 });
    const skipped = state.events.find((e) => e.event === 'tree:tick:skipped');
    expect(skipped).toBeDefined();
    expect(skipped!.category).toBe('nodes');
  });
});

describe('stores — cycleCount', () => {
  let client: MockClient;
  let state: DashboardState;
  let detach: () => void;

  beforeEach(() => {
    ({ client, state, detach } = setup());
    client.emit('snapshot', snapshot());
  });

  afterEach(() => detach());

  it('cycleCount starts at 0', () => {
    expect(state.cycleCount).toBe(0);
  });

  it('RUNNING ticks do not increment cycleCount', () => {
    client.emit('tree:tick', { status: 'running', durationMs: 10 });
    expect(state.cycleCount).toBe(0);
    client.emit('tree:tick', { status: 'running', durationMs: 5 });
    expect(state.cycleCount).toBe(0);
  });

  it('terminal tick increments cycleCount', () => {
    client.emit('tree:tick', { status: 'running', durationMs: 5 });
    client.emit('tree:tick', { status: 'success', durationMs: 10 });
    expect(state.cycleCount).toBe(1);
  });

  it('cycleCount accumulates correctly across multiple cycles', () => {
    client.emit('tree:tick', { status: 'running', durationMs: 5 });
    client.emit('tree:tick', { status: 'success', durationMs: 10 });
    client.emit('tree:tick', { status: 'running', durationMs: 5 });
    client.emit('tree:tick', { status: 'failure', durationMs: 8 });
    expect(state.cycleCount).toBe(2);
    expect(state.tickCount).toBe(4);
  });

  it('single-tick cycles (immediate terminal) each count', () => {
    client.emit('tree:tick', { status: 'success', durationMs: 1 });
    expect(state.cycleCount).toBe(1);
    client.emit('tree:tick', { status: 'failure', durationMs: 1 });
    expect(state.cycleCount).toBe(2);
  });
});
