# Task 123: Implement useBlackboard and useBlackboardSnapshot

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the `useBlackboard` and `useBlackboardSnapshot` hooks for reactive blackboard access.

**Depends on:** Task 122 (provider and context)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md` — useBlackboard and useBlackboardSnapshot sections

---

### Step 1: Implement useBlackboard

Add to `packages/react/src/hooks.ts`:

```ts
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';

export function useBlackboard<T = unknown>(key: string): [T | undefined, (value: T) => Promise<void>] {
  const { client, store } = useCartographerContext();

  // Track the version we last saw for this key, so useSyncExternalStore
  // can detect changes cheaply via getSnapshot identity.
  const versionRef = useRef<number>(-1);
  const valueRef = useRef<T | undefined>(undefined);

  const subscribe = store.subscribe;

  const getSnapshot = useCallback(() => {
    const currentVersion = store.getBlackboardVersion(key);
    if (currentVersion !== versionRef.current) {
      versionRef.current = currentVersion;
      valueRef.current = store.getBlackboardValue(key) as T | undefined;
    }
    return valueRef.current;
  }, [store, key]);

  const value = useSyncExternalStore(subscribe, getSnapshot);

  const setter = useCallback(
    async (newValue: T): Promise<void> => {
      await client.write(key, newValue);
    },
    [client, key],
  );

  return [value, setter];
}
```

**Key behavior:**
- Uses per-key version counters from SyncStore to skip re-renders when other keys change
- The setter calls `client.write()` and returns a promise — it rejects with `ConflictError` on 409
- No optimistic update — value changes when the SSE echo arrives

### Step 2: Implement useBlackboardSnapshot

```ts
export function useBlackboardSnapshot(): Record<string, unknown> {
  const { store } = useCartographerContext();

  const versionRef = useRef<number>(-1);
  const snapshotRef = useRef<Record<string, unknown>>({});

  const getSnapshot = useCallback(() => {
    const currentVersion = store.getGlobalVersion();
    if (currentVersion !== versionRef.current) {
      versionRef.current = currentVersion;
      snapshotRef.current = store.getBlackboardSnapshot();
    }
    return snapshotRef.current;
  }, [store]);

  return useSyncExternalStore(store.subscribe, getSnapshot);
}
```

**Key behavior:**
- Re-renders on any blackboard key change (uses global version counter)
- Returns a new object reference only when something actually changed

### Step 3: Update exports

Add `useBlackboard` and `useBlackboardSnapshot` to `packages/react/src/index.ts`.

### Step 4: Verify

Run:
- `npm run typecheck --workspace=packages/react`
- `npm run build --workspace=packages/react`

### Step 5: Commit

```bash
git add packages/react/src/
git commit -m "feat(react): implement useBlackboard and useBlackboardSnapshot hooks"
```
