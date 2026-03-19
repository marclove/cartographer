# Task 27: Svelte Package — Connection and Tree Status

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `getConnectionStatus()` and `getTreeStatus()` — reactive accessors for connection and tree tick state.

**Architecture:** Both read `CartographerState` from context and return objects with getter properties that access `$state` fields, making them reactive in Svelte 5 templates and derived expressions.

**Tech Stack:** TypeScript, Svelte 5 runes, `@testing-library/svelte`, Vitest

**Depends on:** Task 24 (CartographerState), Task 25 (Provider)

---

### Step 1: Write failing tests

Create `packages/svelte/src/status.test.svelte.ts`:

The key behaviors to test:

```ts
import { describe, it, expect } from 'vitest';

describe('getConnectionStatus', () => {
  it('returns connecting initially');
  it('returns connected after snapshot event');
  it('returns connecting on connection:error with readyState 0');
  it('returns disconnected on connection:error with readyState 2');
});

describe('getTreeStatus', () => {
  it('returns null before first tree:tick');
  it('returns status after tree:tick');
  it('increments localTickCount');
  it('resets on snapshot');
});
```

These tests follow the same patterns as the React `useConnectionStatus` and `useTreeStatus` tests, rendered within a `<Cartographer>` provider with a mock client.

### Step 2: Run tests to verify they fail

Run: `pnpm --filter @cartographer/svelte test`
Expected: FAIL — cannot import status functions

### Step 3: Implement getConnectionStatus and getTreeStatus

Create `packages/svelte/src/status.svelte.ts`:

```ts
import { getContext } from 'svelte';
import { CartographerState } from './state.svelte.js';
import { CARTOGRAPHER_STATE_KEY } from './context.js';
import type { ConnectionStatus, TreeStatusInfo } from './types.js';

export interface ConnectionStatusRef {
  readonly current: ConnectionStatus;
}

export interface TreeStatusRef {
  readonly current: TreeStatusInfo | null;
}

export function getConnectionStatus(): ConnectionStatusRef {
  const state = getContext<CartographerState>(CARTOGRAPHER_STATE_KEY);
  if (!state) {
    throw new Error('Cartographer functions must be used within a <Cartographer> provider');
  }

  return {
    get current(): ConnectionStatus {
      return state.connectionStatus;
    },
  };
}

export function getTreeStatus(): TreeStatusRef {
  const state = getContext<CartographerState>(CARTOGRAPHER_STATE_KEY);
  if (!state) {
    throw new Error('Cartographer functions must be used within a <Cartographer> provider');
  }

  return {
    get current(): TreeStatusInfo | null {
      return state.treeStatus;
    },
  };
}
```

### Step 4: Run tests to verify they pass

Run: `pnpm --filter @cartographer/svelte test`
Expected: PASS

### Step 5: Commit

```bash
git add packages/svelte/src/status.svelte.ts packages/svelte/src/status.test.svelte.ts packages/svelte/src/__tests__/
git commit -m "feat(svelte): implement getConnectionStatus and getTreeStatus"
```
