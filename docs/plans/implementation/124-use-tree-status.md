# Task 124: Implement useTreeStatus

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the `useTreeStatus` hook for reactive tree execution status.

**Depends on:** Task 122 (provider and context)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md` — useTreeStatus section

**Approach:** TDD — write failing tests first, then minimal implementation.

---

### Step 1: RED — Write failing tests

Add to `packages/react/src/hooks.test.tsx`:

- Returns `null` before first `tree:tick` event
- Returns `{ status: 'success', durationMs: 42, localTickCount: 1 }` after first `tree:tick` event
- Increments `localTickCount` on subsequent `tree:tick` events
- Resets to `null` after a new `snapshot` event (reconnection)
- Re-renders after each tick

### Step 2: Verify RED

Run: `npx vitest run packages/react/src/hooks.test.tsx`

### Step 3: GREEN — Implement useTreeStatus

Add to `packages/react/src/hooks.ts`. Thin wrapper around `useSyncExternalStore(store.subscribe, store.getTreeStatus)`.

### Step 4: Verify GREEN

Run: `npx vitest run packages/react/src/hooks.test.tsx` — tree status tests pass.

### Step 5: Update exports and commit

Add `useTreeStatus` to `packages/react/src/index.ts`.

```bash
git add packages/react/src/
git commit -m "feat(react): implement useTreeStatus hook"
```
