# Task 127: Tests for @cartographer/react

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Write unit tests for all hooks and the provider using React Testing Library.

**Depends on:** Tasks 121–126 (all hooks implemented)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md`

---

### Context

Tests should use `@testing-library/react` with `renderHook` and `act`. The CartographerClient can be mocked since hooks interact with it through well-defined interfaces (`on`, `off`, `connect`, `disconnect`, `write`, `action`, etc.).

### Step 1: Add test dependencies

Add to root or `packages/react` devDependencies:
- `@testing-library/react`
- `@testing-library/react-hooks` (if needed for older patterns, though `renderHook` is in `@testing-library/react` v14+)
- `jsdom` (vitest environment)

Ensure vitest config for the react package uses `environment: 'jsdom'`.

### Step 2: Create mock client helper

Create `packages/react/src/test-utils.ts`:

```ts
import type { CartographerClient } from '@cartographer/client';

/** Creates a mock CartographerClient that stores listeners and lets tests simulate SSE events. */
export function createMockClient(): CartographerClient & {
  emit(event: string, data: unknown): void;
} {
  const listeners = new Map<string, Set<(data: unknown) => void>>();

  return {
    action: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    write: vi.fn().mockResolvedValue({ id: 'msg-2' }),
    send: vi.fn().mockResolvedValue({ id: 'msg-3' }),
    actionAndWait: vi.fn().mockResolvedValue({ messageId: 'msg-1', treeStatus: 'success' }),
    interrupt: vi.fn().mockResolvedValue({ interrupted: false }),
    resume: vi.fn().mockResolvedValue({ resumed: true }),
    interruptAndAction: vi.fn().mockResolvedValue({ id: 'msg-4' }),
    blackboard: vi.fn().mockResolvedValue({}),
    tree: vi.fn().mockResolvedValue({}),
    status: vi.fn().mockResolvedValue({}),
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    onAny: vi.fn(),
    off(event, handler) {
      listeners.get(event)?.delete(handler);
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    // Test helper: simulate an SSE event
    emit(event: string, data: unknown) {
      const handlers = listeners.get(event);
      if (handlers) {
        for (const handler of handlers) handler(data);
      }
    },
  };
}
```

### Step 3: Write provider tests

Create `packages/react/src/provider.test.tsx`:

- Provider calls `client.connect()` on mount
- Provider calls `client.disconnect()` on unmount
- Hooks throw when used outside provider
- Provider creates new client when `url` prop changes

### Step 4: Write useBlackboard tests

Create `packages/react/src/hooks.test.tsx`:

- Returns `undefined` for unset keys before snapshot arrives
- Populates value from snapshot event
- Updates value on `blackboard:write` event for matching key
- Does not re-render on `blackboard:write` for different key
- Setter calls `client.write()` with correct key and value
- Setter rejects when `client.write()` rejects

### Step 5: Write useBlackboardSnapshot tests

- Returns empty object before snapshot
- Returns full blackboard after snapshot event
- Re-renders on any key change

### Step 6: Write useTreeStatus tests

- Returns `null` before first tree:tick
- Returns status info after tree:tick event
- Increments localTickCount on each tick
- Resets on new snapshot event

### Step 7: Write useAction tests

- `send()` calls `client.action()` with correct name and payload
- `pending` becomes `true` after `send()`
- `pending` becomes `false` when `message:processed` event arrives with matching ID
- `pending` becomes `false` when `message:failed` event arrives with matching ID
- `sendAndWait()` calls `client.actionAndWait()`
- `pending` is managed correctly during `sendAndWait()` lifecycle

### Step 8: Write useClientEvent tests

- Registers listener with `client.on()`
- Calls handler when event fires
- Cleans up listener on unmount
- Uses latest handler reference (no stale closure)

### Step 9: Write useTreeEvent tests

- Same pattern as useClientEvent but with raw event types

### Step 10: Write useConnectionStatus tests

- Returns initial connection status from store
- Updates when connection status changes in store

### Step 11: Verify

Run:
- `npx vitest run packages/react/src/`
- `npm run typecheck --workspace=packages/react`

### Step 12: Commit

```bash
git add packages/react/src/
git commit -m "test(react): comprehensive unit tests for all hooks and provider"
```
