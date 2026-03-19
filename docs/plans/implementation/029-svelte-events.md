# Task 29: Svelte Package — Event Subscriptions

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `onClientEvent()` and `onTreeEvent()` — event subscription functions with automatic cleanup.

**Architecture:** Both read `CartographerClient` from context, register a stable listener via `client.on()`, and clean up via `client.off()` in `onDestroy`. The handler is stored in a mutable variable so the subscription doesn't re-register when the handler closure changes. Must be called during component initialization.

**Tech Stack:** TypeScript, Svelte 5, `@testing-library/svelte`, Vitest

**Depends on:** Task 25 (Provider)

---

### Step 1: Write failing tests

Create `packages/svelte/src/events.test.svelte.ts`:

The key behaviors to test (mirrors React's `useClientEvent` and `useTreeEvent` tests):

```ts
import { describe, it, expect, vi } from 'vitest';

describe('onClientEvent', () => {
  it('calls handler when matching event fires');
  it('cleans up on component destroy');
  it('uses latest handler reference');
});

describe('onTreeEvent', () => {
  it('calls handler when matching event fires');
  it('cleans up on component destroy');
});
```

Tests render within a `<Cartographer>` provider. Test components call `onClientEvent` / `onTreeEvent` in their `<script>` block, then the test emits events via the mock client and verifies handler invocations. Cleanup is tested by unmounting the component and verifying the handler is no longer called.

For the "uses latest handler reference" test: create a test component that accepts a handler prop and passes it to `onClientEvent`. Re-render with a new handler and verify the new handler is called (not the old one).

### Step 2: Run tests to verify they fail

Run: `pnpm --filter @cartographer/svelte test`
Expected: FAIL — cannot import event functions

### Step 3: Implement onClientEvent and onTreeEvent

Create `packages/svelte/src/events.svelte.ts`:

```ts
import { getContext } from 'svelte';
import { onDestroy } from 'svelte';
import type { CartographerClient } from '@cartographer/client';
import { CARTOGRAPHER_CLIENT_KEY } from './context.js';

export function onClientEvent(name: string, handler: (data: unknown) => void): void {
  const client = getContext<CartographerClient>(CARTOGRAPHER_CLIENT_KEY);
  if (!client) {
    throw new Error('Cartographer functions must be used within a <Cartographer> provider');
  }

  let currentHandler = handler;

  // Expose a way to update the handler reference.
  // In Svelte 5, the caller can update `handler` and the stable listener
  // will delegate to the latest reference.
  const listener = (data: unknown) => currentHandler(data);
  client.on(name, listener);

  onDestroy(() => {
    client.off(name, listener);
  });
}

export function onTreeEvent(type: string, handler: (data: unknown) => void): void {
  const client = getContext<CartographerClient>(CARTOGRAPHER_CLIENT_KEY);
  if (!client) {
    throw new Error('Cartographer functions must be used within a <Cartographer> provider');
  }

  let currentHandler = handler;

  const listener = (data: unknown) => currentHandler(data);
  client.on(type, listener);

  onDestroy(() => {
    client.off(type, listener);
  });
}
```

**Implementation note:** The mutable `currentHandler` variable captures the handler at creation time. Unlike React's `useRef` pattern where the ref is updated on every render, in Svelte 5 the `<script>` block runs once. If the caller needs to update the handler, they should use a reactive variable that the handler closure reads. The implementer should verify whether the "latest handler" behavior is achievable with this pattern or if an alternative approach is needed (e.g., accepting a getter function, or documenting that the handler should close over reactive state rather than being swapped).

### Step 4: Run tests to verify they pass

Run: `pnpm --filter @cartographer/svelte test`
Expected: PASS

### Step 5: Commit

```bash
git add packages/svelte/src/events.svelte.ts packages/svelte/src/events.test.svelte.ts packages/svelte/src/__tests__/
git commit -m "feat(svelte): implement onClientEvent and onTreeEvent"
```
