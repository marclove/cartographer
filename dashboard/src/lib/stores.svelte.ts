import { connectSSE, fetchNode } from './api.js';
import type {
  TreeNode,
  SseEventName,
  SseEventMap,
} from './types.js';

// ---------------------------------------------------------------------------
// Local types not present in types.ts
// ---------------------------------------------------------------------------

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export type NodeStatus = 'running' | 'success' | 'failure' | null;

export interface TimelineEvent<K extends SseEventName = SseEventName> {
  id: number;
  event: K;
  timestamp: number;
  data: SseEventMap[K];
  category: string;
}

// ---------------------------------------------------------------------------
// Event categorization
// ---------------------------------------------------------------------------

const EVENT_CATEGORIES: Partial<Record<SseEventName, string>> = {
  'node:enter': 'nodes',
  'node:exit': 'nodes',
  'node:error': 'nodes',
  'tree:init': 'nodes',
  'tree:tick': 'nodes',
  'tree:reset': 'nodes',
  'tree:abort': 'nodes',
  'tree:tick:skipped': 'nodes',
  'agent:prompt': 'agent',
  'agent:thinking': 'agent',
  'agent:text': 'agent',
  'agent:tool_use': 'agent',
  'agent:response': 'agent',
  'agent:error': 'agent',
  'agent:message': 'agent',
  'agent:tool_progress': 'agent',
  'agent:init': 'agent',
  'agent:status': 'agent',
  'agent:rate_limit': 'agent',
  'agent:elicitation_declined': 'agent',
  'blackboard:write': 'blackboard',
  'strategy:decision': 'strategy',
};

export function getEventCategory(eventName: string): string {
  return EVENT_CATEGORIES[eventName as SseEventName] ?? 'other';
}

// ---------------------------------------------------------------------------
// Reactive state
// ---------------------------------------------------------------------------

const MAX_EVENTS = 2000;

// Connection
let connectionState = $state<ConnectionState>('connecting');
export function getConnectionState(): ConnectionState {
  return connectionState;
}

// Tree structure
// `Snapshot.tree` IS the root TreeNode directly (no wrapper object).
let treeName = $state<string>('');
let treeRoot = $state<TreeNode | null>(null);
export function getTreeName(): string {
  return treeName;
}
export function getTreeRoot(): TreeNode | null {
  return treeRoot;
}

// Node status tracking
let nodeStatuses = $state<Map<string, NodeStatus>>(new Map());
export function getNodeStatuses(): Map<string, NodeStatus> {
  return nodeStatuses;
}

// Run stats (updated from tree:tick events)
let tickCount = $state(0);
let cycleCount = $state(0);
let lastStatus = $state<string | null>(null);
let lastDurationMs = $state<number | null>(null);
export function getTickCount(): number {
  return tickCount;
}
export function getCycleCount(): number {
  return cycleCount;
}
export function getLastStatus(): string | null {
  return lastStatus;
}
export function getLastDurationMs(): number | null {
  return lastDurationMs;
}

// Event timeline
let events = $state<TimelineEvent[]>([]);
export function getEvents(): TimelineEvent[] {
  return events;
}

// Event filters — all categories active by default
let activeFilters = $state<Set<string>>(
  new Set(['nodes', 'agent', 'blackboard', 'strategy']),
);
export function getActiveFilters(): Set<string> {
  return activeFilters;
}
export function toggleFilter(filter: string): void {
  const next = new Set(activeFilters);
  if (next.has(filter)) {
    next.delete(filter);
  } else {
    next.add(filter);
  }
  activeFilters = next;
}

// Blackboard
let blackboard = $state<Record<string, unknown>>({});
let recentlyUpdatedKeys = $state<Set<string>>(new Set());
export function getBlackboard(): Record<string, unknown> {
  return blackboard;
}
export function getRecentlyUpdatedKeys(): Set<string> {
  return recentlyUpdatedKeys;
}

// Selected node
let selectedNodeId = $state<string | null>(null);
let nodeDetail = $state<Record<string, unknown> | null>(null);
export function getSelectedNodeId(): string | null {
  return selectedNodeId;
}
export function getNodeDetail(): Record<string, unknown> | null {
  return nodeDetail;
}
export function selectNode(id: string | null): void {
  if (id === null) {
    selectedNodeId = null;
    nodeDetail = null;
    return;
  }
  // Toggle: clicking the already-selected node deselects it
  selectedNodeId = selectedNodeId === id ? null : id;
  if (selectedNodeId) {
    fetchNode(selectedNodeId).then((data) => {
      nodeDetail = data as unknown as Record<string, unknown>;
    }).catch(() => {
      nodeDetail = null;
    });
  } else {
    nodeDetail = null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pushEvent<K extends SseEventName>(
  event: K,
  data: SseEventMap[K],
  id: number,
): void {
  const entry: TimelineEvent<K> = {
    id,
    event,
    timestamp: Date.now(),
    data,
    category: getEventCategory(event),
  };
  // Mutate-then-trim: only reallocate when the buffer overflows
  events.push(entry as TimelineEvent);
  if (events.length > MAX_EVENTS) {
    events = events.slice(-MAX_EVENTS);
  } else {
    events = events;  // trigger Svelte reactivity
  }
}

// ---------------------------------------------------------------------------
// SSE connection
// ---------------------------------------------------------------------------

// Per-key highlight timers for blackboard updates
let highlightTimers = new Map<string, ReturnType<typeof setTimeout>>();

let cleanup: (() => void) | null = null;

export function connect(): void {
  if (cleanup) cleanup();

  connectionState = 'connecting';

  cleanup = connectSSE({
    onOpen() {
      connectionState = 'connected';
    },

    onError(_err) {
      connectionState = 'disconnected';
    },

    // Snapshot: contains the full tree root and blackboard state
    snapshot(data, id) {
      // snapshot.tree IS the root TreeNode
      treeName = data.tree.name;
      treeRoot = data.tree;
      blackboard = data.blackboard;
      // Reset node statuses when a fresh snapshot arrives
      nodeStatuses = new Map();
      pushEvent('snapshot', data, id);
    },

    'node:enter'(data, id) {
      // When the root node is entered, a new tick is starting — clear stale
      // statuses from the previous tick so indicators don't mix across ticks.
      const next = (treeRoot && data.node.id === treeRoot.id)
        ? new Map<string, NodeStatus>()
        : new Map(nodeStatuses);
      next.set(data.node.id, 'running');
      nodeStatuses = next;
      pushEvent('node:enter', data, id);
    },

    'node:exit'(data, id) {
      const next = new Map(nodeStatuses);
      next.set(data.node.id, data.status);
      nodeStatuses = next;
      pushEvent('node:exit', data, id);
    },

    'node:error'(data, id) {
      const next = new Map(nodeStatuses);
      next.set(data.node.id, 'failure');
      nodeStatuses = next;
      pushEvent('node:error', data, id);
    },

    'tree:tick'(data, id) {
      tickCount += 1;
      lastStatus = data.status;
      if (data.status !== 'running') {
        cycleCount += 1;
      }
      lastDurationMs = data.durationMs;
      pushEvent('tree:tick', data, id);
    },

    'tree:tick:skipped'(data, id) {
      pushEvent('tree:tick:skipped', data, id);
    },

    'tree:reset'(data, id) {
      nodeStatuses = new Map();
      pushEvent('tree:reset', data, id);
    },

    'tree:init'(data, id) {
      pushEvent('tree:init', data, id);
    },

    'tree:abort'(data, id) {
      pushEvent('tree:abort', data, id);
    },

    'blackboard:write'(data, id) {
      const key = typeof data.key === 'string' ? data.key : null;
      if (key !== null) {
        blackboard = { ...blackboard, [key]: data.value };
        const next = new Set(recentlyUpdatedKeys);
        next.add(key);
        recentlyUpdatedKeys = next;
        // Cancel any existing timer for this key so the highlight stays
        // for a full 2 seconds from the most recent write
        const existing = highlightTimers.get(key);
        if (existing !== undefined) clearTimeout(existing);
        highlightTimers.set(key, setTimeout(() => {
          const cleared = new Set(recentlyUpdatedKeys);
          cleared.delete(key);
          recentlyUpdatedKeys = cleared;
          highlightTimers.delete(key);
        }, 2000));
      }
      pushEvent('blackboard:write', data, id);
    },

    'strategy:decision'(data, id) {
      pushEvent('strategy:decision', data, id);
    },

    'agent:prompt'(data, id) {
      pushEvent('agent:prompt', data, id);
    },
    'agent:thinking'(data, id) {
      pushEvent('agent:thinking', data, id);
    },
    'agent:text'(data, id) {
      pushEvent('agent:text', data, id);
    },
    'agent:tool_use'(data, id) {
      pushEvent('agent:tool_use', data, id);
    },
    'agent:response'(data, id) {
      pushEvent('agent:response', data, id);
    },
    'agent:error'(data, id) {
      pushEvent('agent:error', data, id);
    },
    // agent:message intentionally ignored — duplicates the specialized
    // agent:thinking, agent:text, agent:tool_use, and agent:response events.
    'agent:tool_progress'(data, id) {
      pushEvent('agent:tool_progress', data, id);
    },
    'agent:init'(data, id) {
      pushEvent('agent:init', data, id);
    },
    'agent:status'(data, id) {
      pushEvent('agent:status', data, id);
    },
    'agent:rate_limit'(data, id) {
      pushEvent('agent:rate_limit', data, id);
    },
    'agent:elicitation_declined'(data, id) {
      pushEvent('agent:elicitation_declined', data, id);
    },
  });
}

export function disconnect(): void {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  connectionState = 'disconnected';
}

/** Reset all store state. Exported for tests only. */
export function _resetForTest(): void {
  disconnect();
  connectionState = 'connecting';
  treeName = '';
  treeRoot = null;
  nodeStatuses = new Map();
  tickCount = 0;
  cycleCount = 0;
  lastStatus = null;
  lastDurationMs = null;
  events = [];
  activeFilters = new Set(['nodes', 'agent', 'blackboard', 'strategy']);
  blackboard = {};
  for (const timer of highlightTimers.values()) clearTimeout(timer);
  highlightTimers.clear();
  recentlyUpdatedKeys = new Set();
  selectedNodeId = null;
  nodeDetail = null;
}
