# Task 123: Implement useBlackboard and useBlackboardSnapshot

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the `useBlackboard` and `useBlackboardSnapshot` hooks for reactive blackboard access.

**Depends on:** Task 122 (provider and context)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md` — useBlackboard and useBlackboardSnapshot sections

**Approach:** TDD — write failing tests first, then minimal implementation.

---

### Step 1: RED — Write failing tests for useBlackboard

Add to `packages/react/src/hooks.test.tsx`. All tests render hooks wrapped in `<CartographerProvider client={mockClient}>`.

- Returns `[undefined, setter]` for an unset key before any snapshot event
- Returns `['hello', setter]` after a snapshot event with `{ blackboard: { name: 'hello' } }` for `useBlackboard('name')`
- Updates value when a `blackboard:write` event arrives with matching key
- Does NOT trigger re-render when a `blackboard:write` event arrives for a different key (use `renderHook` render count or a spy to verify)
- Setter calls `client.write(key, value)` with the correct arguments
- Setter returns a promise that resolves on success
- Setter propagates rejection when `client.write()` rejects

### Step 2: Verify RED

Run: `npx vitest run packages/react/src/hooks.test.tsx`

### Step 3: GREEN — Implement useBlackboard

Add to `packages/react/src/hooks.ts`. Uses `useSyncExternalStore` with per-key version tracking from SyncStore. Setter wraps `client.write()`.

### Step 4: Verify GREEN

Run: `npx vitest run packages/react/src/hooks.test.tsx` — useBlackboard tests pass.

### Step 5: RED — Write failing tests for useBlackboardSnapshot

- Returns empty object `{}` before snapshot event
- Returns full blackboard after snapshot event
- Re-renders when any key changes via `blackboard:write`
- Returns a new object reference after a change

### Step 6: Verify RED

Run: `npx vitest run packages/react/src/hooks.test.tsx`

### Step 7: GREEN — Implement useBlackboardSnapshot

Uses `useSyncExternalStore` with global version counter.

### Step 8: Verify GREEN

Run: `npx vitest run packages/react/src/hooks.test.tsx` — all blackboard hook tests pass.

### Step 9: REFACTOR

Review both hooks for shared patterns. Extract if warranted. Keep tests green.

### Step 10: Update exports and commit

Add `useBlackboard` and `useBlackboardSnapshot` to `packages/react/src/index.ts`.

```bash
git add packages/react/src/
git commit -m "feat(react): implement useBlackboard and useBlackboardSnapshot hooks"
```
