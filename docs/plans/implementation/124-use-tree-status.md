# Task 124: Implement useTreeStatus

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the `useTreeStatus` hook for reactive tree execution status.

**Depends on:** Task 122 (provider and context)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md` — useTreeStatus section

---

### Step 1: Implement useTreeStatus

Add to `packages/react/src/hooks.ts`:

```ts
export function useTreeStatus(): TreeStatusInfo | null {
  const { store } = useCartographerContext();
  return useSyncExternalStore(store.subscribe, store.getTreeStatus);
}
```

**Key behavior:**
- Returns `null` until the first `tree:tick` SSE event arrives
- After each tick, returns `{ status, durationMs, localTickCount }`
- `localTickCount` is a client-side counter that increments on each `tree:tick` event — it resets on SSE reconnect
- Re-renders after every tick (the `TreeStatusInfo` object reference changes each time)
- For authoritative server-side tick/cycle counts, use `useClient()` and call `client.status()` directly

### Step 2: Update exports

Add `useTreeStatus` to `packages/react/src/index.ts`.

### Step 3: Verify

Run:
- `npm run typecheck --workspace=packages/react`

### Step 4: Commit

```bash
git add packages/react/src/
git commit -m "feat(react): implement useTreeStatus hook"
```
