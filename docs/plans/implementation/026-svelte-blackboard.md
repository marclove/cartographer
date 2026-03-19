# Task 26: Svelte Package — Blackboard Functions

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `getBlackboard()` and `getBlackboardSnapshot()` — fine-grained reactive accessors for blackboard state.

**Architecture:** Both functions read `CartographerState` and `CartographerClient` from Svelte context. `getBlackboard(key)` returns a `BlackboardRef` with a `$derived` getter for that specific key and a `set()` method. `getBlackboardSnapshot()` returns a `$derived` getter over the full blackboard object.

**Tech Stack:** TypeScript, Svelte 5 runes, `@testing-library/svelte`, Vitest

**Depends on:** Task 24 (CartographerState), Task 25 (Provider)

---

### Step 1: Write failing tests for getBlackboard

Create `packages/svelte/src/blackboard.test.svelte.ts`:

Testing these functions requires Svelte context (they call `getContext`), so tests need to render within a `<Cartographer>` provider. Create test wrapper components as needed under `src/__tests__/`.

The key behaviors to test:

```ts
import { describe, it, expect, vi } from 'vitest';

describe('getBlackboard', () => {
  it('returns undefined for unset key before snapshot');
  it('returns value after snapshot');
  it('updates on blackboard:write for matching key');
  it('setter calls client.write with correct args');
  it('setter propagates rejection');
});

describe('getBlackboardSnapshot', () => {
  it('returns empty object before snapshot');
  it('returns full blackboard after snapshot');
  it('updates on any key change');
});
```

The test approach:
- Create a wrapper `.svelte` test component that renders `<Cartographer client={mockClient}>` and calls the function under test, exposing results via a callback prop or reactive bindings
- Or use `createTestContext()` to set up context manually with `setContext` in a test component
- The exact testing pattern depends on `@testing-library/svelte`'s Svelte 5 capabilities

The behaviors mirror the React `useBlackboard` and `useBlackboardSnapshot` tests exactly (see `packages/react/src/hooks.test.tsx`).

### Step 2: Run tests to verify they fail

Run: `pnpm --filter @cartographer/svelte test`
Expected: FAIL — cannot import blackboard functions

### Step 3: Implement getBlackboard and getBlackboardSnapshot

Create `packages/svelte/src/blackboard.svelte.ts`:

```ts
import { getContext } from 'svelte';
import type { CartographerClient } from '@cartographer/client';
import { CartographerState } from './state.svelte.js';
import { CARTOGRAPHER_CLIENT_KEY, CARTOGRAPHER_STATE_KEY } from './context.js';

export interface BlackboardRef<T> {
  readonly value: T | undefined;
  set(newValue: T): Promise<void>;
}

export interface BlackboardSnapshotRef {
  readonly current: Record<string, unknown>;
}

export function getBlackboard<T = unknown>(key: string): BlackboardRef<T> {
  const client = getContext<CartographerClient>(CARTOGRAPHER_CLIENT_KEY);
  const state = getContext<CartographerState>(CARTOGRAPHER_STATE_KEY);
  if (!client || !state) {
    throw new Error('Cartographer functions must be used within a <Cartographer> provider');
  }

  return {
    get value(): T | undefined {
      return state.blackboardEntries[key] as T | undefined;
    },
    async set(newValue: T): Promise<void> {
      await client.write(key, newValue);
    },
  };
}

export function getBlackboardSnapshot(): BlackboardSnapshotRef {
  const state = getContext<CartographerState>(CARTOGRAPHER_STATE_KEY);
  if (!state) {
    throw new Error('Cartographer functions must be used within a <Cartographer> provider');
  }

  return {
    get current(): Record<string, unknown> {
      return state.blackboardEntries;
    },
  };
}
```

Note: The `value` and `current` getters access `$state` properties on `CartographerState`, which makes them reactive when read in a Svelte 5 reactive context (template, `$derived`, `$effect`). No explicit `$derived` wrapper is needed — Svelte 5's fine-grained reactivity tracks property access automatically.

### Step 4: Run tests to verify they pass

Run: `pnpm --filter @cartographer/svelte test`
Expected: PASS

### Step 5: Commit

```bash
git add packages/svelte/src/blackboard.svelte.ts packages/svelte/src/blackboard.test.svelte.ts packages/svelte/src/__tests__/
git commit -m "feat(svelte): implement getBlackboard and getBlackboardSnapshot"
```
