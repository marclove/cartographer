import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SseHandlers } from './api.js';
import type { Snapshot, NodeEnterEvent, NodeExitEvent, NodeErrorEvent, TreeNode } from './types.js';

// Mock connectSSE and fetchNode so the store never touches the network.
// We capture the handlers object passed to connectSSE so we can invoke
// individual callbacks to simulate SSE events.
vi.mock('./api.js', () => ({
  connectSSE: vi.fn(() => vi.fn()),
  fetchNode: vi.fn().mockResolvedValue({}),
}));

import { connectSSE } from './api.js';
import {
  connect,
  getNodeStatuses,
  getTreeRoot,
  getTreeName,
  getEvents,
  getBlackboard,
  getTickCount,
  getLastStatus,
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
});
