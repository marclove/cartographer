# Task 23: Svelte Package — Test Utilities

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `createMockClient()` and `createTestContext()` — the test infrastructure all subsequent tasks will use for TDD.

**Architecture:** `test-utils.svelte.ts` uses `.svelte.ts` because `createTestContext` creates a `CartographerState` instance which uses runes. `createMockClient()` mirrors the React package's mock exactly: all `CartographerClient` methods are `vi.fn()`, with an `emit(event, data)` helper for simulating SSE events.

**Tech Stack:** TypeScript, Vitest, Svelte 5 runes

**Depends on:** Task 22 (types and context)

---

### Step 1: Write failing tests for createMockClient

Create `packages/svelte/src/test-utils.test.svelte.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createMockClient } from './test-utils.svelte.js';

describe('createMockClient', () => {
  it('has all CartographerClient methods', () => {
    const client = createMockClient();
    expect(client.action).toBeDefined();
    expect(client.write).toBeDefined();
    expect(client.send).toBeDefined();
    expect(client.actionAndWait).toBeDefined();
    expect(client.interrupt).toBeDefined();
    expect(client.resume).toBeDefined();
    expect(client.interruptAndAction).toBeDefined();
    expect(client.blackboard).toBeDefined();
    expect(client.tree).toBeDefined();
    expect(client.status).toBeDefined();
    expect(client.on).toBeDefined();
    expect(client.onAny).toBeDefined();
    expect(client.off).toBeDefined();
    expect(client.connect).toBeDefined();
    expect(client.disconnect).toBeDefined();
  });

  it('emit dispatches to registered listeners', () => {
    const client = createMockClient();
    const handler = vi.fn();
    client.on('test-event', handler);
    client.emit('test-event', { foo: 'bar' });
    expect(handler).toHaveBeenCalledWith({ foo: 'bar' });
  });

  it('off removes a listener', () => {
    const client = createMockClient();
    const handler = vi.fn();
    client.on('test-event', handler);
    client.off('test-event', handler);
    client.emit('test-event', { foo: 'bar' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('action returns default mock response', async () => {
    const client = createMockClient();
    const result = await client.action('test');
    expect(result).toEqual({ id: 'msg-1' });
  });
});
```

### Step 2: Run tests to verify they fail

Run: `pnpm --filter @cartographer/svelte test`
Expected: FAIL — cannot import from `./test-utils.svelte.js`

### Step 3: Implement createMockClient

Create `packages/svelte/src/test-utils.svelte.ts`:

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
    on(event: string, handler: (data: unknown) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    onAny: vi.fn(),
    off(event: string, handler: (data: unknown) => void) {
      listeners.get(event)?.delete(handler);
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit(event: string, data: unknown) {
      const handlers = listeners.get(event);
      if (handlers) {
        for (const handler of handlers) handler(data);
      }
    },
  };
}
```

Note: `createTestContext()` will be added in Task 24 after `CartographerState` exists. This file uses `.svelte.ts` in anticipation of that addition.

### Step 4: Run tests to verify they pass

Run: `pnpm --filter @cartographer/svelte test`
Expected: PASS

### Step 5: Commit

```bash
git add packages/svelte/src/test-utils.svelte.ts packages/svelte/src/test-utils.test.svelte.ts
git commit -m "feat(svelte): add createMockClient test utility"
```
