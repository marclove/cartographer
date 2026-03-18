# Task 126: Implement useClientEvent and useTreeEvent

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the `useClientEvent` and `useTreeEvent` hooks for subscribing to SSE events.

**Depends on:** Task 122 (provider and context)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md` — useClientEvent and useTreeEvent sections

---

### Step 1: Implement useClientEvent

Add to `packages/react/src/hooks.ts`:

```ts
export function useClientEvent(name: string, handler: (data: unknown) => void): void {
  const { client } = useCartographerContext();

  // Keep handler ref-stable to avoid stale closures
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = (data: unknown) => handlerRef.current(data);
    client.on(name, listener);
    return () => client.off(name, listener);
  }, [client, name]);
}
```

**Key behavior:**
- Subscribes to named `client:event` events from `EmitToClientNode` — the client's `dispatchEvent` already maps `client:event` names to direct listeners, so `client.on('ui:show_modal', handler)` works
- The handler is ref-stable: the effect doesn't re-run when the handler function changes, but always calls the latest version
- For side effects only — this hook does not return state

### Step 2: Implement useTreeEvent

```ts
export function useTreeEvent(type: string, handler: (data: unknown) => void): void {
  const { client } = useCartographerContext();

  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = (data: unknown) => handlerRef.current(data);
    client.on(type, listener);
    return () => client.off(type, listener);
  }, [client, type]);
}
```

**Key behavior:**
- Same pattern as `useClientEvent` but subscribes to raw SSE event types (`node:enter`, `agent:text`, `tree:tick`, etc.)
- The distinction from `useClientEvent` is semantic — `useClientEvent` is for named events from `EmitToClientNode`, `useTreeEvent` is for framework-level events
- Both use the same underlying `client.on/off` mechanism

### Step 3: Update exports

Add `useClientEvent` and `useTreeEvent` to `packages/react/src/index.ts`.

### Step 4: Verify

Run:
- `npm run typecheck --workspace=packages/react`

### Step 5: Commit

```bash
git add packages/react/src/
git commit -m "feat(react): implement useClientEvent and useTreeEvent hooks"
```
