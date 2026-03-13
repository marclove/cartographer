# Task 53: Svelte Stores

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create reactive Svelte 5 stores that manage dashboard state — tree structure, events, blackboard, connection status, and selected node. These stores are the reactive backbone that all components read from.

**Depends on:** Task 52

---

### Step 1: Create the store module

Create `dashboard/src/lib/stores.svelte.ts`:

```ts
import { connectSSE, fetchStatus } from './api.js';
import type { TreeNode, RunStatus, Snapshot, TimelineEvent, ConnectionState, NodeStatus } from './types.js';

// --- Connection state ---
let connectionState = $state<ConnectionState>('connecting');
export function getConnectionState() { return connectionState; }

// --- Tree structure ---
let treeName = $state<string>('');
let treeRoot = $state<TreeNode | null>(null);
export function getTreeName() { return treeName; }
export function getTreeRoot() { return treeRoot; }

// --- Node status tracking (updated from events) ---
let nodeStatuses = $state<Map<string, NodeStatus>>(new Map());
export function getNodeStatuses() { return nodeStatuses; }

// --- Run status ---
let tickCount = $state(0);
let lastStatus = $state<NodeStatus>(null);
let lastDurationMs = $state<number | null>(null);
export function getTickCount() { return tickCount; }
export function getLastStatus() { return lastStatus; }
export function getLastDurationMs() { return lastDurationMs; }

// --- Event timeline ---
const MAX_EVENTS = 2000;
let events = $state<TimelineEvent[]>([]);
export function getEvents() { return events; }

// --- Event filters ---
let activeFilters = $state<Set<string>>(new Set(['nodes', 'agent', 'blackboard', 'strategy']));
export function getActiveFilters() { return activeFilters; }
export function toggleFilter(filter: string) {
  const next = new Set(activeFilters);
  if (next.has(filter)) next.delete(filter);
  else next.add(filter);
  activeFilters = next;
}

// --- Blackboard ---
let blackboard = $state<Record<string, unknown>>({});
let recentlyUpdatedKeys = $state<Set<string>>(new Set());
export function getBlackboard() { return blackboard; }
export function getRecentlyUpdatedKeys() { return recentlyUpdatedKeys; }

// --- Selected node ---
let selectedNodeId = $state<string | null>(null);
export function getSelectedNodeId() { return selectedNodeId; }
export function selectNode(id: string | null) {
  selectedNodeId = selectedNodeId === id ? null : id;
}

// --- Event categorization ---
const EVENT_CATEGORIES: Record<string, string> = {
  'node:enter': 'nodes',
  'node:exit': 'nodes',
  'node:error': 'nodes',
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
  'tree:init': 'nodes',
  'tree:tick': 'nodes',
  'tree:reset': 'nodes',
  'tree:abort': 'nodes',
};

export function getEventCategory(eventName: string): string {
  return EVENT_CATEGORIES[eventName] ?? 'other';
}

// --- SSE connection ---
let cleanup: (() => void) | null = null;

export function connect(): void {
  if (cleanup) cleanup();

  cleanup = connectSSE({
    onSnapshot: (snapshot: Snapshot) => {
      treeName = snapshot.tree.name;
      treeRoot = snapshot.tree.root;
      blackboard = snapshot.blackboard;
      // Reset node statuses on reconnect
      nodeStatuses = new Map();
    },
    onEvent: (event: TimelineEvent) => {
      // Append to timeline (cap at MAX_EVENTS)
      events = [...events, event].slice(-MAX_EVENTS);

      // Update node statuses
      if (event.event === 'node:enter') {
        const nodeId = (event.data.node as any)?.id;
        if (nodeId) {
          const next = new Map(nodeStatuses);
          next.set(nodeId, 'running');
          nodeStatuses = next;
        }
      }
      if (event.event === 'node:exit') {
        const nodeId = (event.data.node as any)?.id;
        const status = event.data.status as NodeStatus;
        if (nodeId) {
          const next = new Map(nodeStatuses);
          next.set(nodeId, status);
          nodeStatuses = next;
        }
      }
      if (event.event === 'tree:reset') {
        nodeStatuses = new Map();
      }

      // Update run status from tree:tick
      if (event.event === 'tree:tick') {
        tickCount++;
        lastStatus = event.data.status as NodeStatus;
        lastDurationMs = event.data.durationMs as number;
      }

      // Update blackboard
      if (event.event === 'blackboard:write') {
        const key = event.data.key as string;
        blackboard = { ...blackboard, [key]: event.data.value };
        const next = new Set(recentlyUpdatedKeys);
        next.add(key);
        recentlyUpdatedKeys = next;
        // Clear highlight after 2 seconds
        setTimeout(() => {
          const cleared = new Set(recentlyUpdatedKeys);
          cleared.delete(key);
          recentlyUpdatedKeys = cleared;
        }, 2000);
      }
    },
    onConnectionChange: (state: ConnectionState) => {
      connectionState = state;
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
```

### Step 2: Wire up stores in App.svelte

Edit `dashboard/src/App.svelte` — add SSE connection on mount:

```svelte
<script lang="ts">
  import { connect, disconnect } from './lib/stores.svelte.js';
  import { onMount } from 'svelte';

  onMount(() => {
    connect();
    return () => disconnect();
  });
</script>
```

### Step 3: Verify build

Run: `npm run dashboard:build`
Expected: Build succeeds.

### Step 4: Commit

```bash
git add dashboard/src/lib/stores.svelte.ts dashboard/src/App.svelte
git commit -m "feat(dashboard): add reactive Svelte stores with SSE integration"
```
