# Task 24: Svelte Package — Internal Reactive State

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `CartographerState` — the internal runes-based reactive state class that bridges SSE events from `CartographerClient` into Svelte 5 reactivity.

**Architecture:** A class using `$state` runes for all reactive fields. The `attach(client)` method registers SSE event handlers (`snapshot`, `blackboard:write`, `tree:tick`, `connection:error`) and returns a cleanup function. This replaces the React package's `SyncStore` with Svelte-native reactivity.

**Tech Stack:** TypeScript, Svelte 5 runes, Vitest

**Depends on:** Task 22 (types), Task 23 (createMockClient)

---

### Step 1: Write failing tests for CartographerState

Create `packages/svelte/src/state.test.svelte.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { CartographerState } from './state.svelte.js';
import { createMockClient } from './test-utils.svelte.js';

describe('CartographerState', () => {
  it('has correct initial state', () => {
    const state = new CartographerState();
    expect(state.connectionStatus).toBe('connecting');
    expect(state.blackboardEntries).toEqual({});
    expect(state.blackboardVersions).toEqual({});
    expect(state.globalVersion).toBe(0);
    expect(state.treeStatus).toBeNull();
  });

  it('populates blackboard from snapshot event', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('snapshot', { blackboard: { name: 'Alice', age: 30 } });

    expect(state.blackboardEntries['name']).toBe('Alice');
    expect(state.blackboardEntries['age']).toBe(30);
  });

  it('sets connectionStatus to connected on snapshot', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    expect(state.connectionStatus).toBe('connecting');
    client.emit('snapshot', { blackboard: {} });
    expect(state.connectionStatus).toBe('connected');
  });

  it('resets version counters on snapshot', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('snapshot', { blackboard: { x: 1 } });
    client.emit('blackboard:write', { key: 'x', value: 2 });
    const versionAfterWrite = state.blackboardVersions['x'];
    expect(versionAfterWrite).toBeGreaterThan(0);

    client.emit('snapshot', { blackboard: { x: 10 } });
    expect(state.blackboardVersions['x']).toBe(1);
  });

  it('updates correct key on blackboard:write', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('snapshot', { blackboard: { a: 1, b: 2 } });
    client.emit('blackboard:write', { key: 'a', value: 99 });

    expect(state.blackboardEntries['a']).toBe(99);
    expect(state.blackboardEntries['b']).toBe(2);
  });

  it('bumps version for written key only', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('snapshot', { blackboard: { a: 1, b: 2 } });
    const versionA = state.blackboardVersions['a'];
    const versionB = state.blackboardVersions['b'];

    client.emit('blackboard:write', { key: 'a', value: 99 });

    expect(state.blackboardVersions['a']).toBe(versionA + 1);
    expect(state.blackboardVersions['b']).toBe(versionB);
  });

  it('bumps globalVersion on blackboard:write', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('snapshot', { blackboard: {} });
    const v0 = state.globalVersion;

    client.emit('blackboard:write', { key: 'x', value: 1 });
    expect(state.globalVersion).toBe(v0 + 1);

    client.emit('blackboard:write', { key: 'y', value: 2 });
    expect(state.globalVersion).toBe(v0 + 2);
  });

  it('updates tree status on tree:tick', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    expect(state.treeStatus).toBeNull();

    client.emit('tree:tick', { tree: 'test', status: 'success', durationMs: 42 });

    expect(state.treeStatus).toEqual({
      status: 'success',
      durationMs: 42,
      localTickCount: 1,
    });
  });

  it('increments localTickCount on each tree:tick', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('tree:tick', { tree: 'test', status: 'success', durationMs: 10 });
    client.emit('tree:tick', { tree: 'test', status: 'running', durationMs: 20 });
    client.emit('tree:tick', { tree: 'test', status: 'failure', durationMs: 30 });

    expect(state.treeStatus!.localTickCount).toBe(3);
    expect(state.treeStatus!.status).toBe('failure');
    expect(state.treeStatus!.durationMs).toBe(30);
  });

  it('resets tree status on new snapshot', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('tree:tick', { tree: 'test', status: 'success', durationMs: 42 });
    expect(state.treeStatus).not.toBeNull();

    client.emit('snapshot', { blackboard: {} });
    expect(state.treeStatus).toBeNull();
  });

  it('sets connectionStatus to connecting on connection:error with readyState 0', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('snapshot', { blackboard: {} });
    expect(state.connectionStatus).toBe('connected');

    client.emit('connection:error', { readyState: 0 });
    expect(state.connectionStatus).toBe('connecting');
  });

  it('sets connectionStatus to disconnected on connection:error with readyState 2', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('snapshot', { blackboard: {} });
    expect(state.connectionStatus).toBe('connected');

    client.emit('connection:error', { readyState: 2 });
    expect(state.connectionStatus).toBe('disconnected');
  });

  it('recovers to connected when snapshot arrives after connection:error', () => {
    const state = new CartographerState();
    const client = createMockClient();
    state.attach(client);

    client.emit('snapshot', { blackboard: {} });
    client.emit('connection:error', { readyState: 0 });
    expect(state.connectionStatus).toBe('connecting');

    client.emit('snapshot', { blackboard: { x: 1 } });
    expect(state.connectionStatus).toBe('connected');
  });

  it('detach removes event handlers and sets disconnected', () => {
    const state = new CartographerState();
    const client = createMockClient();
    const detach = state.attach(client);

    client.emit('snapshot', { blackboard: { x: 1 } });
    expect(state.connectionStatus).toBe('connected');

    detach();
    expect(state.connectionStatus).toBe('disconnected');

    // After detach, events should not update state
    client.emit('blackboard:write', { key: 'x', value: 2 });
    expect(state.blackboardEntries['x']).toBe(1);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `pnpm --filter @cartographer/svelte test`
Expected: FAIL — cannot import `CartographerState`

### Step 3: Implement CartographerState

Create `packages/svelte/src/state.svelte.ts`:

```ts
import type { CartographerClient } from '@cartographer/client';
import type { TreeStatusInfo, ConnectionStatus } from './types.js';

export class CartographerState {
  connectionStatus = $state<ConnectionStatus>('connecting');
  blackboardEntries = $state<Record<string, unknown>>({});
  blackboardVersions = $state<Record<string, number>>({});
  globalVersion = $state(0);
  treeStatus = $state<TreeStatusInfo | null>(null);

  attach(client: CartographerClient): () => void {
    const onSnapshot = (data: unknown) => {
      const d = data as { blackboard: Record<string, unknown> };
      this.blackboardEntries = { ...d.blackboard };
      const versions: Record<string, number> = {};
      for (const key of Object.keys(d.blackboard)) {
        versions[key] = 1;
      }
      this.blackboardVersions = versions;
      this.globalVersion++;
      this.treeStatus = null;
      this.connectionStatus = 'connected';
    };

    const onBlackboardWrite = (data: unknown) => {
      const d = data as { key: string; value: unknown };
      this.blackboardEntries = { ...this.blackboardEntries, [d.key]: d.value };
      this.blackboardVersions = {
        ...this.blackboardVersions,
        [d.key]: (this.blackboardVersions[d.key] ?? 0) + 1,
      };
      this.globalVersion++;
    };

    const onTreeTick = (data: unknown) => {
      const d = data as { status: string; durationMs: number };
      this.treeStatus = {
        status: d.status,
        durationMs: d.durationMs,
        localTickCount: (this.treeStatus?.localTickCount ?? 0) + 1,
      };
    };

    const onConnectionError = (data: unknown) => {
      const d = data as { readyState: number };
      if (d.readyState === 2) {
        this.connectionStatus = 'disconnected';
      } else {
        this.connectionStatus = 'connecting';
      }
    };

    client.on('snapshot', onSnapshot);
    client.on('blackboard:write', onBlackboardWrite);
    client.on('tree:tick', onTreeTick);
    client.on('connection:error', onConnectionError);

    return () => {
      client.off('snapshot', onSnapshot);
      client.off('blackboard:write', onBlackboardWrite);
      client.off('tree:tick', onTreeTick);
      client.off('connection:error', onConnectionError);
      this.connectionStatus = 'disconnected';
    };
  }
}
```

### Step 4: Run tests to verify they pass

Run: `pnpm --filter @cartographer/svelte test`
Expected: PASS (all 14 tests)

### Step 5: Add createTestContext to test-utils

Now that `CartographerState` exists, add `createTestContext` to `packages/svelte/src/test-utils.svelte.ts`:

```ts
import { CartographerState } from './state.svelte.js';

export function createTestContext(overrides?: Partial<CartographerClient>): {
  client: CartographerClient & { emit(event: string, data: unknown): void };
  state: CartographerState;
} {
  const client = createMockClient();
  if (overrides) {
    Object.assign(client, overrides);
  }
  const state = new CartographerState();
  state.attach(client);
  return { client, state };
}
```

Add a test for `createTestContext` in `packages/svelte/src/test-utils.test.svelte.ts`:

```ts
describe('createTestContext', () => {
  it('returns a wired client and state', () => {
    const { client, state } = createTestContext();
    client.emit('snapshot', { blackboard: { x: 1 } });
    expect(state.blackboardEntries['x']).toBe(1);
    expect(state.connectionStatus).toBe('connected');
  });

  it('accepts overrides', async () => {
    const customAction = vi.fn().mockResolvedValue({ id: 'custom' });
    const { client } = createTestContext({ action: customAction });
    const result = await client.action('test');
    expect(result.id).toBe('custom');
  });
});
```

### Step 6: Run tests to verify they pass

Run: `pnpm --filter @cartographer/svelte test`
Expected: PASS

### Step 7: Commit

```bash
git add packages/svelte/src/state.svelte.ts packages/svelte/src/state.test.svelte.ts packages/svelte/src/test-utils.svelte.ts packages/svelte/src/test-utils.test.svelte.ts
git commit -m "feat(svelte): implement CartographerState and createTestContext"
```
