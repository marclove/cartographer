# Task 121: Implement SyncStore

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the internal reactive store that bridges SSE events from `CartographerClient` to React's `useSyncExternalStore`.

**Depends on:** Task 120 (react package scaffold)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md` — Sync Store section

**Approach:** TDD — write failing tests first, then minimal implementation.

---

### Context

The SyncStore is internal (not exported from the package). It:
- Maintains a local cache of blackboard state and tree status
- Updates incrementally from SSE events (`blackboard:write`, `tree:tick`, `snapshot`)
- Exposes `subscribe` + `getSnapshot` functions compatible with `useSyncExternalStore`
- Tracks per-key version counters so hooks can cheaply detect changes to specific keys

### SyncStore interface (for test authoring)

```ts
export interface SyncStore {
  getBlackboardValue(key: string): unknown;
  getBlackboardVersion(key: string): number;
  getBlackboardSnapshot(): Record<string, unknown>;
  getGlobalVersion(): number;
  getTreeStatus(): TreeStatusInfo | null;
  getConnectionStatus(): ConnectionStatus;
  subscribe(listener: () => void): () => void;
  attach(client: CartographerClient): () => void;
}
```

### Step 1: RED — Write failing tests

Create `packages/react/src/store.test.ts`. Use `createMockClient()` from `test-utils.ts` to simulate SSE events. Write tests for all store behaviors:

- `createSyncStore()` returns a store with empty initial state
- Snapshot event populates blackboard from `{ blackboard: { key: 'val' } }`
- Snapshot event resets version counters and sets connectionStatus to `'connected'`
- `blackboard:write` event with `{ key: 'foo', value: 'bar' }` updates the correct key
- `blackboard:write` bumps the version for the written key
- `blackboard:write` does NOT bump versions for other keys
- `blackboard:write` bumps the global version
- `tree:tick` event with `{ status: 'success', durationMs: 42 }` updates tree status
- `tree:tick` increments `localTickCount` on each event
- Snapshot event resets `localTickCount` to 0
- Subscribers are called on each state mutation
- `subscribe()` returns an unsubscribe function that removes the listener
- `attach()` returns a cleanup function — after cleanup, events no longer update the store

### Step 2: Verify RED

Run: `npx vitest run packages/react/src/store.test.ts`

Confirm all tests fail because `createSyncStore` doesn't exist yet (or is a stub).

### Step 3: GREEN — Implement SyncStore

Create `packages/react/src/store.ts` with minimal implementation to pass all tests:

- On `snapshot` SSE event: replace `blackboard` entirely, reset all `blackboardVersions`, reset `treeStatus`, bump `globalVersion`, set `connectionStatus` to `'connected'`
- On `blackboard:write` SSE event: update `blackboard[key]`, bump `blackboardVersions[key]`, bump `globalVersion`
- On `tree:tick` SSE event: replace `treeStatus` with `{ status, durationMs, localTickCount: prev + 1 }`
- `attach(client)` registers `client.on(...)` handlers for `snapshot`, `blackboard:write`, `tree:tick` and returns a cleanup function that calls `client.off(...)` for each
- All mutations notify subscribers by calling every registered listener

### Step 4: Verify GREEN

Run: `npx vitest run packages/react/src/store.test.ts`

All tests pass. Also run: `npm run typecheck --workspace=packages/react`

### Step 5: REFACTOR

Review the implementation for any duplication or clarity improvements. Keep tests green.

### Step 6: Commit

```bash
git add packages/react/src/store.ts packages/react/src/store.test.ts
git commit -m "feat(react): implement SyncStore for SSE-to-React state bridging"
```
