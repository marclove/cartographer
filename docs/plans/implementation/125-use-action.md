# Task 125: Implement useAction

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the `useAction` hook for sending actions to the tree with pending state tracking.

**Depends on:** Task 122 (provider and context)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md` — useAction section

---

### Step 1: Implement useAction

Add to `packages/react/src/hooks.ts`:

```ts
interface UseActionReturn {
  send: (payload?: unknown) => Promise<{ id: string }>;
  sendAndWait: (payload?: unknown) => Promise<{ messageId: string; treeStatus: string }>;
  pending: boolean;
}

export function useAction(name: string): UseActionReturn {
  const { client } = useCartographerContext();
  const [pending, setPending] = useState(false);
  const pendingIdRef = useRef<string | null>(null);

  // Listen for message:processed and message:failed to clear pending state
  useEffect(() => {
    const onProcessed = (data: unknown) => {
      const d = data as { messageId: string };
      if (d.messageId === pendingIdRef.current) {
        pendingIdRef.current = null;
        setPending(false);
      }
    };
    const onFailed = (data: unknown) => {
      const d = data as { messageId: string };
      if (d.messageId === pendingIdRef.current) {
        pendingIdRef.current = null;
        setPending(false);
      }
    };
    client.on('message:processed', onProcessed);
    client.on('message:failed', onFailed);
    return () => {
      client.off('message:processed', onProcessed);
      client.off('message:failed', onFailed);
    };
  }, [client]);

  const send = useCallback(
    async (payload?: unknown): Promise<{ id: string }> => {
      const result = await client.action(name, payload);
      pendingIdRef.current = result.id;
      setPending(true);
      return result;
    },
    [client, name],
  );

  const sendAndWait = useCallback(
    async (payload?: unknown): Promise<{ messageId: string; treeStatus: string }> => {
      setPending(true);
      try {
        const result = await client.actionAndWait(name, payload);
        return result;
      } finally {
        pendingIdRef.current = null;
        setPending(false);
      }
    },
    [client, name],
  );

  return { send, sendAndWait, pending };
}
```

**Key behavior:**
- `send()` sets `pending = true` immediately after the HTTP response, clears it when `message:processed` or `message:failed` SSE event arrives with the matching message ID
- `sendAndWait()` sets `pending = true` before the call, clears it when the promise resolves/rejects (it internally waits for the SSE events)
- `pending` requires an active SSE connection to clear when using `send()` — without SSE, it stays `true` indefinitely
- Both `send()` and `sendAndWait()` propagate `ConflictError` on 409

### Step 2: Update exports

Add `useAction` to `packages/react/src/index.ts`.

### Step 3: Verify

Run:
- `npm run typecheck --workspace=packages/react`

### Step 4: Commit

```bash
git add packages/react/src/
git commit -m "feat(react): implement useAction hook with pending state tracking"
```
