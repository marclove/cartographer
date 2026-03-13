import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SseHandlers } from './api.js';
import type { Snapshot, NodeEnterEvent, NodeExitEvent, NodeErrorEvent, TreeNode } from './types.js';

// Mock connectSSE and fetchNode so the store never touches the network.
// We capture the handlers object passed to connectSSE so we can invoke
// individual callbacks to simulate SSE events.
vi.mock('./api.js', () => ({
  connectSSE: vi.fn(() => vi.fn()),
  fetchNode: vi.fn().mockResolvedValue({}),
}));

import { connectSSE, fetchNode } from './api.js';
import {
  connect,
  disconnect,
  getConnectionState,
  getNodeStatuses,
  getTreeRoot,
  getTreeName,
  getEvents,
  getBlackboard,
  getRecentlyUpdatedKeys,
  getTickCount,
  getLastStatus,
  getLastDurationMs,
  getActiveFilters,
  toggleFilter,
  getSelectedNodeId,
  getNodeDetail,
  selectNode,
  getEventCategory,
  _resetForTest,
} from './stores.svelte.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT_NODE: TreeNode = {
  id: 'root',
  name: 'Root',
  type: 'sequence',
  children: [
    { id: 'child-a', name: 'ChildA', type: 'action', children: [] },
    { id: 'child-b', name: 'ChildB', type: 'action', children: [] },
  ],
};

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    tree: ROOT_NODE,
    blackboard: {},
    ...overrides,
  };
}

/** Call connect(), then extract the handlers object passed to connectSSE. */
function getHandlers(): SseHandlers {
  const mock = vi.mocked(connectSSE);
  mock.mockClear();
  connect();
  expect(mock).toHaveBeenCalledOnce();
  return mock.mock.calls[0][0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stores — node status tracking', () => {
  let h: SseHandlers;

  beforeEach(() => {
    _resetForTest();
    h = getHandlers();
    // Always start with a snapshot so the store knows the tree structure
    h.snapshot!(snapshot(), 1);
  });

  it('snapshot resets all node statuses', () => {
    // Simulate a node:enter so there's something to clear
    h['node:enter']!({ node: { id: 'root', name: 'Root', type: 'sequence' } }, 2);
    expect(getNodeStatuses().get('root')).toBe('running');

    // New snapshot should clear everything
    h.snapshot!(snapshot(), 3);
    expect(getNodeStatuses().size).toBe(0);
  });

  it('node:enter sets the node status to running', () => {
    h['node:enter']!({ node: { id: 'child-a', name: 'ChildA', type: 'action' } }, 2);
    expect(getNodeStatuses().get('child-a')).toBe('running');
  });

  it('node:exit sets the node status to the exit status', () => {
    h['node:enter']!({ node: { id: 'child-a', name: 'ChildA', type: 'action' } }, 2);
    h['node:exit']!({ node: { id: 'child-a', name: 'ChildA', type: 'action' }, status: 'success', durationMs: 1 }, 3);
    expect(getNodeStatuses().get('child-a')).toBe('success');
  });

  it('node:error sets the node status to failure', () => {
    h['node:enter']!({ node: { id: 'child-b', name: 'ChildB', type: 'action' } }, 2);
    h['node:error']!({ node: { id: 'child-b', name: 'ChildB', type: 'action' }, error: 'boom' }, 3);
    expect(getNodeStatuses().get('child-b')).toBe('failure');
  });

  it('tree:reset clears all node statuses', () => {
    h['node:enter']!({ node: { id: 'root', name: 'Root', type: 'sequence' } }, 2);
    h['tree:reset']!({}, 3);
    expect(getNodeStatuses().size).toBe(0);
  });

  // --- The bug fix: stale statuses across ticks ---

  it('node:enter for the root clears all statuses from the previous tick', () => {
    // Simulate a full tick: root enters, children enter/exit with success
    h['node:enter']!({ node: { id: 'root', name: 'Root', type: 'sequence' } }, 10);
    h['node:enter']!({ node: { id: 'child-a', name: 'ChildA', type: 'action' } }, 11);
    h['node:exit']!({ node: { id: 'child-a', name: 'ChildA', type: 'action' }, status: 'success', durationMs: 1 }, 12);
    h['node:enter']!({ node: { id: 'child-b', name: 'ChildB', type: 'action' } }, 13);
    h['node:exit']!({ node: { id: 'child-b', name: 'ChildB', type: 'action' }, status: 'success', durationMs: 1 }, 14);
    h['node:exit']!({ node: { id: 'root', name: 'Root', type: 'sequence' }, status: 'success', durationMs: 5 }, 15);
    h['tree:tick']!({ status: 'success', durationMs: 5 }, 16);

    // Verify tick 1 statuses are present
    expect(getNodeStatuses().get('child-a')).toBe('success');
    expect(getNodeStatuses().get('child-b')).toBe('success');
    expect(getNodeStatuses().get('root')).toBe('success');

    // New tick starts — root enters
    h['node:enter']!({ node: { id: 'root', name: 'Root', type: 'sequence' } }, 20);

    // Stale statuses from the previous tick should be cleared
    expect(getNodeStatuses().get('child-a')).toBeUndefined();
    expect(getNodeStatuses().get('child-b')).toBeUndefined();
    // Root itself should be running
    expect(getNodeStatuses().get('root')).toBe('running');
  });

  it('node:enter for a non-root node does NOT clear other statuses', () => {
    // Root enters (clears)
    h['node:enter']!({ node: { id: 'root', name: 'Root', type: 'sequence' } }, 10);
    // Child A enters — root should remain running
    h['node:enter']!({ node: { id: 'child-a', name: 'ChildA', type: 'action' } }, 11);

    expect(getNodeStatuses().get('root')).toBe('running');
    expect(getNodeStatuses().get('child-a')).toBe('running');
  });

  it('statuses accumulate correctly within a single tick', () => {
    h['node:enter']!({ node: { id: 'root', name: 'Root', type: 'sequence' } }, 10);
    h['node:enter']!({ node: { id: 'child-a', name: 'ChildA', type: 'action' } }, 11);
    h['node:exit']!({ node: { id: 'child-a', name: 'ChildA', type: 'action' }, status: 'success', durationMs: 1 }, 12);
    h['node:enter']!({ node: { id: 'child-b', name: 'ChildB', type: 'action' } }, 13);

    expect(getNodeStatuses().get('root')).toBe('running');
    expect(getNodeStatuses().get('child-a')).toBe('success');
    expect(getNodeStatuses().get('child-b')).toBe('running');
  });
});

describe('stores — tree structure', () => {
  let h: SseHandlers;

  beforeEach(() => {
    _resetForTest();
    h = getHandlers();
  });

  it('snapshot populates tree root and name', () => {
    h.snapshot!(snapshot(), 1);
    expect(getTreeName()).toBe('Root');
    expect(getTreeRoot()?.id).toBe('root');
    expect(getTreeRoot()?.children).toHaveLength(2);
  });
});

describe('stores — blackboard', () => {
  let h: SseHandlers;

  beforeEach(() => {
    _resetForTest();
    h = getHandlers();
    h.snapshot!(snapshot({ blackboard: { counter: 0 } }), 1);
  });

  it('snapshot sets initial blackboard state', () => {
    expect(getBlackboard()).toEqual({ counter: 0 });
  });

  it('blackboard:write updates the blackboard', () => {
    h['blackboard:write']!({ key: 'counter', value: 1 }, 2);
    expect(getBlackboard()).toEqual({ counter: 1 });
  });

  it('blackboard:write adds new keys', () => {
    h['blackboard:write']!({ key: 'result', value: 'done' }, 2);
    expect(getBlackboard()).toEqual({ counter: 0, result: 'done' });
  });
});

describe('stores — tick stats', () => {
  let h: SseHandlers;

  beforeEach(() => {
    _resetForTest();
    h = getHandlers();
    h.snapshot!(snapshot(), 1);
  });

  it('tree:tick increments tick count and records status', () => {
    h['tree:tick']!({ status: 'success', durationMs: 12 }, 2);
    expect(getTickCount()).toBe(1);
    expect(getLastStatus()).toBe('success');

    h['tree:tick']!({ status: 'failure', durationMs: 5 }, 3);
    expect(getTickCount()).toBe(2);
    expect(getLastStatus()).toBe('failure');
  });
});

describe('stores — event timeline', () => {
  let h: SseHandlers;

  beforeEach(() => {
    _resetForTest();
    h = getHandlers();
    h.snapshot!(snapshot(), 1);
  });

  it('pushes events to the timeline', () => {
    h['node:enter']!({ node: { id: 'root', name: 'Root', type: 'sequence' } }, 2);
    // snapshot (from beforeEach) + node:enter
    const evts = getEvents();
    expect(evts).toHaveLength(2);
    expect(evts[0].event).toBe('snapshot');
    expect(evts[1].event).toBe('node:enter');
  });

  it('categorizes events correctly', () => {
    h['node:enter']!({ node: { id: 'root', name: 'Root', type: 'sequence' } }, 2);
    h['blackboard:write']!({ key: 'x', value: 1 }, 3);

    const evts = getEvents();
    expect(evts[1].category).toBe('nodes');
    expect(evts[2].category).toBe('blackboard');
  });

  it('caps the event timeline at MAX_EVENTS (2000)', () => {
    // Push 2001 additional events (beyond the snapshot from beforeEach)
    for (let i = 0; i < 2001; i++) {
      h['node:enter']!({ node: { id: 'root', name: 'Root', type: 'sequence' } }, 100 + i);
    }
    // MAX_EVENTS is 2000, so the oldest events should be evicted
    expect(getEvents()).toHaveLength(2000);
    // The very first event (snapshot, id=1) should have been evicted
    expect(getEvents()[0].id).not.toBe(1);
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
  beforeEach(() => {
    _resetForTest();
  });

  it('all categories are active by default', () => {
    const filters = getActiveFilters();
    expect(filters.has('nodes')).toBe(true);
    expect(filters.has('agent')).toBe(true);
    expect(filters.has('blackboard')).toBe(true);
    expect(filters.has('strategy')).toBe(true);
  });

  it('toggleFilter removes an active filter', () => {
    toggleFilter('agent');
    expect(getActiveFilters().has('agent')).toBe(false);
    // Others remain
    expect(getActiveFilters().has('nodes')).toBe(true);
  });

  it('toggleFilter re-adds a removed filter', () => {
    toggleFilter('agent');
    expect(getActiveFilters().has('agent')).toBe(false);
    toggleFilter('agent');
    expect(getActiveFilters().has('agent')).toBe(true);
  });
});

describe('stores — connection state', () => {
  let h: SseHandlers;

  beforeEach(() => {
    _resetForTest();
    h = getHandlers();
  });

  it('starts in "connecting" state', () => {
    // _resetForTest sets it to 'connecting', and connect() hasn't
    // fired onOpen yet
    expect(getConnectionState()).toBe('connecting');
  });

  it('transitions to "connected" when onOpen fires', () => {
    h.onOpen!();
    expect(getConnectionState()).toBe('connected');
  });

  it('transitions to "disconnected" when onError fires', () => {
    h.onError!(new Event('error'));
    expect(getConnectionState()).toBe('disconnected');
  });
});

describe('stores — disconnect', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('sets state to disconnected', () => {
    getHandlers(); // connect
    disconnect();
    expect(getConnectionState()).toBe('disconnected');
  });

  it('calls the cleanup function returned by connectSSE', () => {
    const cleanupFn = vi.fn();
    vi.mocked(connectSSE).mockReturnValueOnce(cleanupFn);
    connect();
    disconnect();
    expect(cleanupFn).toHaveBeenCalledOnce();
  });
});

describe('stores — node selection', () => {
  beforeEach(() => {
    _resetForTest();
    const h = getHandlers();
    h.snapshot!(snapshot(), 1);
  });

  it('initially has no selected node', () => {
    expect(getSelectedNodeId()).toBeNull();
    expect(getNodeDetail()).toBeNull();
  });

  it('selectNode sets the selected node id', () => {
    selectNode('child-a');
    expect(getSelectedNodeId()).toBe('child-a');
  });

  it('selectNode fetches node detail', async () => {
    const mockDetail = { id: 'child-a', name: 'ChildA', type: 'action' };
    vi.mocked(fetchNode).mockResolvedValueOnce(mockDetail);

    selectNode('child-a');
    expect(getSelectedNodeId()).toBe('child-a');

    // Wait for the fetchNode promise to resolve
    await vi.waitFor(() => {
      expect(getNodeDetail()).toEqual(mockDetail);
    });
  });

  it('selectNode toggles off when called with the same id', () => {
    selectNode('child-a');
    expect(getSelectedNodeId()).toBe('child-a');
    selectNode('child-a');
    expect(getSelectedNodeId()).toBeNull();
    expect(getNodeDetail()).toBeNull();
  });

  it('selectNode(null) clears selection', () => {
    selectNode('child-a');
    selectNode(null);
    // Calling with null: selectedNodeId === null ? null : null → sets null
    // Actually the logic is: selectedNodeId === id ? null : id
    // selectNode(null): selectedNodeId ('child-a') === null → false → selectedNodeId = null
    expect(getSelectedNodeId()).toBeNull();
  });
});

describe('stores — tick duration', () => {
  let h: SseHandlers;

  beforeEach(() => {
    _resetForTest();
    h = getHandlers();
    h.snapshot!(snapshot(), 1);
  });

  it('tree:tick records lastDurationMs', () => {
    expect(getLastDurationMs()).toBeNull();
    h['tree:tick']!({ status: 'success', durationMs: 42.5 }, 2);
    expect(getLastDurationMs()).toBe(42.5);
  });
});

describe('stores — recentlyUpdatedKeys', () => {
  let h: SseHandlers;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetForTest();
    h = getHandlers();
    h.snapshot!(snapshot({ blackboard: {} }), 1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('blackboard:write adds key to recentlyUpdatedKeys', () => {
    h['blackboard:write']!({ key: 'counter', value: 1 }, 2);
    expect(getRecentlyUpdatedKeys().has('counter')).toBe(true);
  });

  it('recentlyUpdatedKeys clears after 2 seconds', () => {
    h['blackboard:write']!({ key: 'counter', value: 1 }, 2);
    expect(getRecentlyUpdatedKeys().has('counter')).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(getRecentlyUpdatedKeys().has('counter')).toBe(false);
  });

  it('multiple keys can be highlighted simultaneously', () => {
    h['blackboard:write']!({ key: 'a', value: 1 }, 2);
    h['blackboard:write']!({ key: 'b', value: 2 }, 3);
    expect(getRecentlyUpdatedKeys().has('a')).toBe(true);
    expect(getRecentlyUpdatedKeys().has('b')).toBe(true);
  });

  it('blackboard:write with missing key does not update blackboard', () => {
    h['blackboard:write']!({ value: 'no-key' }, 2);
    // Blackboard should remain unchanged
    expect(getBlackboard()).toEqual({});
    expect(getRecentlyUpdatedKeys().size).toBe(0);
  });
});
