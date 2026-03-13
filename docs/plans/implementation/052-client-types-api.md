# Task 52: Client-Side Types and API Client

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create TypeScript types for the dashboard client (mirroring serialized server payloads) and the API client module — REST fetchers and SSE EventSource wrapper.

**Depends on:** Task 51

---

### Step 1: Create client-side types

Create `dashboard/src/lib/types.ts`:

```ts
/** Mirrors SerializedNodeRef from the server */
export interface NodeRef {
  id: string;
  name: string;
  type: string;
}

/** Mirrors SerializedTreeNode — recursive tree structure */
export interface TreeNode extends NodeRef {
  children: TreeNode[];
}

/** Run status from /api/status */
export interface RunStatus {
  tree: string;
  tickCount: number;
  lastStatus: string | null;
  lastDurationMs: number | null;
  uptime: number;
  scheduled: boolean;
  scheduleConfig?: { type: string; expression?: string; intervalMs?: number };
}

/** Snapshot event sent on SSE connect */
export interface Snapshot {
  tree: { name: string; root: TreeNode };
  blackboard: Record<string, unknown>;
  status: RunStatus;
}

/** A single event from the SSE stream */
export interface TimelineEvent {
  id: number;
  event: string;
  data: Record<string, unknown>;
  ts: string;
}

/** Node status values (includes 'paused' for Phase C display readiness) */
export type NodeStatus = 'success' | 'failure' | 'running' | 'paused' | null;

/** Connection state for the SSE client */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
```

### Step 2: Create API client

Create `dashboard/src/lib/api.ts`:

```ts
import type { TreeNode, RunStatus, Snapshot, TimelineEvent, ConnectionState } from './types.js';

const BASE = ''; // Same origin — relative URLs

/** Fetch tree structure */
export async function fetchTree(): Promise<{ tree: string; root: TreeNode }> {
  const res = await fetch(`${BASE}/api/tree`);
  if (!res.ok) throw new Error(`GET /api/tree failed: ${res.status}`);
  return res.json();
}

/** Fetch run status */
export async function fetchStatus(): Promise<RunStatus> {
  const res = await fetch(`${BASE}/api/status`);
  if (!res.ok) throw new Error(`GET /api/status failed: ${res.status}`);
  return res.json();
}

/** Fetch blackboard snapshot */
export async function fetchBlackboard(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/api/blackboard`);
  if (!res.ok) throw new Error(`GET /api/blackboard failed: ${res.status}`);
  return res.json();
}

/** Fetch single node detail */
export async function fetchNode(id: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/api/nodes/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`GET /api/nodes/${id} failed: ${res.status}`);
  return res.json();
}

export interface SSEClientCallbacks {
  onSnapshot: (snapshot: Snapshot) => void;
  onEvent: (event: TimelineEvent) => void;
  onConnectionChange: (state: ConnectionState) => void;
}

/**
 * Connect to the SSE event stream. Returns a cleanup function.
 * Uses the browser's built-in EventSource with auto-reconnect.
 */
export function connectSSE(callbacks: SSEClientCallbacks): () => void {
  const { onSnapshot, onEvent, onConnectionChange } = callbacks;

  const url = `${BASE}/api/events`;
  const source = new EventSource(url);

  source.onopen = () => {
    onConnectionChange('connected');
  };

  source.onerror = () => {
    onConnectionChange(source.readyState === EventSource.CONNECTING ? 'reconnecting' : 'disconnected');
  };

  // Handle snapshot event
  source.addEventListener('snapshot', (e: MessageEvent) => {
    const data = JSON.parse(e.data) as Snapshot;
    onSnapshot(data);
  });

  // All TreeEvents event names — listen for each
  const eventNames = [
    'node:enter', 'node:exit', 'node:error',
    'agent:prompt', 'agent:thinking', 'agent:text', 'agent:tool_use',
    'agent:response', 'agent:error', 'agent:message', 'agent:tool_progress',
    'agent:init', 'agent:status', 'agent:rate_limit', 'agent:elicitation_declined',
    'tree:init', 'tree:tick', 'tree:reset', 'tree:abort',
    'blackboard:write', 'strategy:decision',
  ];

  for (const name of eventNames) {
    source.addEventListener(name, (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      onEvent({
        id: parseInt((e as any).lastEventId ?? '0', 10),
        event: name,
        data,
        ts: data.ts ?? new Date().toISOString(),
      });
    });
  }

  return () => source.close();
}
```

### Step 3: Verify build

Run: `npm run dashboard:build`
Expected: Build succeeds with no type errors. The API client is tree-shaken if not yet imported by App.svelte.

### Step 4: Commit

```bash
git add dashboard/src/lib/types.ts dashboard/src/lib/api.ts
git commit -m "feat(dashboard): add client-side types and API client"
```
