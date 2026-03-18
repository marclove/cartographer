# Task 126: Implement useClientEvent and useTreeEvent

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the `useClientEvent` and `useTreeEvent` hooks for subscribing to SSE events.

**Depends on:** Task 122 (provider and context)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md` — useClientEvent and useTreeEvent sections

**Approach:** TDD — write failing tests first, then minimal implementation.

---

### Step 1: RED — Write failing tests for useClientEvent

Add to `packages/react/src/hooks.test.tsx`:

- Calls handler when matching named event fires via mock client `emit()`
- Does NOT call handler for events with a different name
- Cleans up listener on unmount (verify `client.off` is called or handler stops receiving)
- Handler is ref-stable: updating the handler function (via rerender) calls the latest version, not the stale one

### Step 2: Verify RED

Run: `npx vitest run packages/react/src/hooks.test.tsx`

### Step 3: GREEN — Implement useClientEvent

Add to `packages/react/src/hooks.ts`:

```ts
export function useClientEvent(name: string, handler: (data: unknown) => void): void {
  const { client } = useCartographerContext();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = (data: unknown) => handlerRef.current(data);
    client.on(name, listener);
    return () => client.off(name, listener);
  }, [client, name]);
}
```

### Step 4: Verify GREEN

Run: `npx vitest run packages/react/src/hooks.test.tsx` — useClientEvent tests pass.

### Step 5: RED — Write failing tests for useTreeEvent

- Calls handler when matching event type fires
- Cleans up on unmount
- Handler ref-stable (same pattern as useClientEvent)

### Step 6: Verify RED

### Step 7: GREEN — Implement useTreeEvent

Same pattern as `useClientEvent` — uses `client.on(type, listener)`. The distinction is semantic.

### Step 8: Verify GREEN

Run: `npx vitest run packages/react/src/hooks.test.tsx` — all event hook tests pass.

### Step 9: Update exports and commit

Add `useClientEvent` and `useTreeEvent` to `packages/react/src/index.ts`.

```bash
git add packages/react/src/
git commit -m "feat(react): implement useClientEvent and useTreeEvent hooks"
```
