# Task 28: Svelte Package — Action Function

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `createAction()` — a factory that returns a reactive `ActionRef` with `send()`, `sendAndWait()`, and reactive `pending` state.

**Architecture:** Uses `$state` for `pending`. Registers `message:processed` and `message:failed` SSE listeners once at creation time, filtered by tracked message IDs. Tracks concurrent sends via an in-flight counter + pending ID set (same logic as React's `useAction`). Cleans up listeners via `onDestroy`.

**Tech Stack:** TypeScript, Svelte 5 runes, `@testing-library/svelte`, Vitest

**Depends on:** Task 24 (CartographerState), Task 25 (Provider)

---

### Step 1: Write failing tests

Create `packages/svelte/src/action.test.svelte.ts`:

The key behaviors to test (mirrors React's `useAction` tests):

```ts
import { describe, it, expect, vi } from 'vitest';

describe('createAction', () => {
  it('send() calls client.action with correct args');
  it('send() resolves with id');
  it('pending is false initially');
  it('pending becomes true after send and false after message:processed');
  it('pending becomes false on message:failed');
  it('ignores message:processed for different ID');
  it('pending stays true until all concurrent sends are resolved');
  it('pending clears correctly when one of two concurrent sends fails via HTTP');
  it('send() resets pending on HTTP error');
  it('sendAndWait calls client.actionAndWait');
  it('sendAndWait sets pending during round-trip');
});
```

These tests render within a `<Cartographer>` provider. The mock client's `emit()` simulates `message:processed` and `message:failed` SSE events.

### Step 2: Run tests to verify they fail

Run: `pnpm --filter @cartographer/svelte test`
Expected: FAIL — cannot import `createAction`

### Step 3: Implement createAction

Create `packages/svelte/src/action.svelte.ts`:

```ts
import { getContext } from 'svelte';
import { onDestroy } from 'svelte';
import type { CartographerClient } from '@cartographer/client';
import { CARTOGRAPHER_CLIENT_KEY } from './context.js';

export interface ActionRef {
  readonly pending: boolean;
  send(payload?: unknown): Promise<{ id: string }>;
  sendAndWait(payload?: unknown): Promise<{ messageId: string; treeStatus: string }>;
}

export function createAction(name: string): ActionRef {
  const client = getContext<CartographerClient>(CARTOGRAPHER_CLIENT_KEY);
  if (!client) {
    throw new Error('Cartographer functions must be used within a <Cartographer> provider');
  }

  let pending = $state(false);
  const pendingIds = new Set<string>();
  let inflight = 0;

  function clearIfDone() {
    if (inflight === 0 && pendingIds.size === 0) {
      pending = false;
    }
  }

  const onProcessed = (data: unknown) => {
    const d = data as { messageId: string };
    if (pendingIds.has(d.messageId)) {
      pendingIds.delete(d.messageId);
      clearIfDone();
    }
  };

  const onFailed = (data: unknown) => {
    const d = data as { messageId: string };
    if (pendingIds.has(d.messageId)) {
      pendingIds.delete(d.messageId);
      clearIfDone();
    }
  };

  client.on('message:processed', onProcessed);
  client.on('message:failed', onFailed);

  onDestroy(() => {
    client.off('message:processed', onProcessed);
    client.off('message:failed', onFailed);
  });

  return {
    get pending() {
      return pending;
    },
    async send(payload?: unknown): Promise<{ id: string }> {
      inflight += 1;
      pending = true;
      try {
        const result = await client.action(name, payload);
        inflight -= 1;
        pendingIds.add(result.id);
        return result;
      } catch (err) {
        inflight -= 1;
        clearIfDone();
        throw err;
      }
    },
    async sendAndWait(payload?: unknown): Promise<{ messageId: string; treeStatus: string }> {
      pending = true;
      try {
        return await client.actionAndWait(name, payload);
      } finally {
        pending = false;
      }
    },
  };
}
```

### Step 4: Run tests to verify they pass

Run: `pnpm --filter @cartographer/svelte test`
Expected: PASS

### Step 5: Commit

```bash
git add packages/svelte/src/action.svelte.ts packages/svelte/src/action.test.svelte.ts packages/svelte/src/__tests__/
git commit -m "feat(svelte): implement createAction with pending state tracking"
```
