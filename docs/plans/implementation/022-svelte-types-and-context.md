# Task 22: Svelte Package — Types and Context

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Define shared types (`TreeStatusInfo`, `ConnectionStatus`) and the Svelte context key with `getClient()` helper.

**Architecture:** `types.ts` is plain TypeScript (no runes). `context.ts` is plain TypeScript — uses Svelte's `getContext`/`setContext` but doesn't need runes. Both are foundational files that other modules import.

**Tech Stack:** TypeScript, Svelte 5 context API

---

### Step 1: Write failing tests for types

Create `packages/svelte/src/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { TreeStatusInfo, ConnectionStatus } from './types.js';

describe('types', () => {
  it('TreeStatusInfo has the expected shape', () => {
    const info: TreeStatusInfo = {
      status: 'success',
      durationMs: 42,
      localTickCount: 1,
    };
    expect(info.status).toBe('success');
    expect(info.durationMs).toBe(42);
    expect(info.localTickCount).toBe(1);
  });

  it('ConnectionStatus accepts valid values', () => {
    const statuses: ConnectionStatus[] = ['connecting', 'connected', 'disconnected'];
    expect(statuses).toHaveLength(3);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `pnpm --filter @cartographer/svelte test`
Expected: FAIL — cannot import from `./types.js`

### Step 3: Implement types.ts

Create `packages/svelte/src/types.ts`:

```ts
export interface TreeStatusInfo {
  status: string;
  durationMs: number;
  localTickCount: number;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';
```

### Step 4: Run tests to verify they pass

Run: `pnpm --filter @cartographer/svelte test`
Expected: PASS

### Step 5: Write failing tests for context

Create `packages/svelte/src/context.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CARTOGRAPHER_CLIENT_KEY, CARTOGRAPHER_STATE_KEY } from './context.js';

describe('context', () => {
  it('exports unique context keys', () => {
    expect(CARTOGRAPHER_CLIENT_KEY).toBeDefined();
    expect(CARTOGRAPHER_STATE_KEY).toBeDefined();
    expect(CARTOGRAPHER_CLIENT_KEY).not.toBe(CARTOGRAPHER_STATE_KEY);
  });
});
```

Note: `getClient()` requires Svelte component context to test properly (it calls `getContext`), so it will be tested as part of the Provider task (Task 24). Here we only verify the context keys exist.

### Step 6: Run tests to verify they fail

Run: `pnpm --filter @cartographer/svelte test`
Expected: FAIL — cannot import from `./context.js`

### Step 7: Implement context.ts

Create `packages/svelte/src/context.ts`:

```ts
import { getContext } from 'svelte';
import type { CartographerClient } from '@cartographer/client';

export const CARTOGRAPHER_CLIENT_KEY = Symbol('cartographer-client');
export const CARTOGRAPHER_STATE_KEY = Symbol('cartographer-state');

export function getClient(): CartographerClient {
  const client = getContext<CartographerClient | undefined>(CARTOGRAPHER_CLIENT_KEY);
  if (!client) {
    throw new Error('Cartographer functions must be used within a <Cartographer> provider');
  }
  return client;
}
```

### Step 8: Run tests to verify they pass

Run: `pnpm --filter @cartographer/svelte test`
Expected: PASS

### Step 9: Commit

```bash
git add packages/svelte/src/types.ts packages/svelte/src/types.test.ts packages/svelte/src/context.ts packages/svelte/src/context.test.ts
git commit -m "feat(svelte): add types and context module"
```
