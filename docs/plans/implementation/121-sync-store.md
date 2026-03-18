# Task 121: Implement SyncStore

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the internal reactive store that bridges SSE events from `CartographerClient` to React's `useSyncExternalStore`.

**Depends on:** Task 120 (react package scaffold)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md` — Sync Store section

---

### Context

The SyncStore is internal (not exported). It:
- Maintains a local cache of blackboard state and tree status
- Updates incrementally from SSE events (`blackboard:write`, `tree:tick`, `snapshot`)
- Exposes `subscribe` + `getSnapshot` functions compatible with `useSyncExternalStore`
- Tracks per-key version counters so hooks can cheaply detect changes to specific keys

### Step 1: Implement SyncStore

Create `packages/react/src/store.ts`:

```ts
import type { CartographerClient } from '@cartographer/client';
import type { TreeStatusInfo, ConnectionStatus } from './types.js';

interface SyncStoreState {
  blackboard: Record<string, unknown>;
  blackboardVersions: Record<string, number>;
  globalVersion: number;
  treeStatus: TreeStatusInfo | null;
  connectionStatus: ConnectionStatus;
}

export interface SyncStore {
  /** Get the current value of a blackboard key. */
  getBlackboardValue(key: string): unknown;
  /** Get the version counter for a blackboard key (for change detection). */
  getBlackboardVersion(key: string): number;
  /** Get the full blackboard snapshot. */
  getBlackboardSnapshot(): Record<string, unknown>;
  /** Get the global version counter (bumped on any blackboard change). */
  getGlobalVersion(): number;
  /** Get the latest tree status. */
  getTreeStatus(): TreeStatusInfo | null;
  /** Get the connection status. */
  getConnectionStatus(): ConnectionStatus;
  /** Subscribe to store changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Connect to the client's SSE events. Returns a cleanup function. */
  attach(client: CartographerClient): () => void;
}
```

**Implementation details:**

- `subscribe/getSnapshot` follows the `useSyncExternalStore` contract: `subscribe` takes a callback, returns an unsubscribe function; getters return immutable snapshots
- On `snapshot` SSE event: replace `blackboard` entirely, reset all `blackboardVersions`, reset `treeStatus`, bump `globalVersion`, set `connectionStatus` to `'connected'`
- On `blackboard:write` SSE event: update `blackboard[key]`, bump `blackboardVersions[key]`, bump `globalVersion`
- On `tree:tick` SSE event: replace `treeStatus` with `{ status, durationMs, localTickCount: prev + 1 }`
- `attach(client)` registers `client.on(...)` handlers for `snapshot`, `blackboard:write`, `tree:tick` and returns a cleanup function that calls `client.off(...)` for each
- All mutations notify subscribers by calling every registered listener

### Step 2: Write unit tests

Create `packages/react/src/store.test.ts`:

Test the store in isolation by calling `attach()` with a mock client that simulates SSE events:
- Snapshot event populates blackboard and resets versions
- `blackboard:write` updates the correct key and bumps its version
- Other key versions remain unchanged after a single-key write
- `tree:tick` updates tree status and increments `localTickCount`
- `globalVersion` increments on every blackboard change
- Subscribers are called on each state change
- Unsubscribe removes the listener
- Cleanup from `attach()` removes all event handlers

### Step 3: Verify

Run:
- `npx vitest run packages/react/src/store.test.ts`
- `npm run typecheck --workspace=packages/react`

### Step 4: Commit

```bash
git add packages/react/src/store.ts packages/react/src/store.test.ts
git commit -m "feat(react): implement SyncStore for SSE-to-React state bridging"
```
