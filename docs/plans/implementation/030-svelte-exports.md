# Task 30: Svelte Package — Package Exports and Integration Verification

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire up the public `index.ts` barrel export, verify the full test suite passes, and ensure the package builds cleanly.

**Architecture:** `index.ts` re-exports the public API from all modules. This is the final integration step that ensures everything works together.

**Tech Stack:** TypeScript, Svelte 5, Vitest

**Depends on:** Tasks 21-29 (all previous Svelte tasks)

---

### Step 1: Write failing test for exports

Create `packages/svelte/src/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as pkg from './index.js';

describe('@cartographer/svelte exports', () => {
  it('exports Cartographer component', () => {
    expect(pkg.Cartographer).toBeDefined();
  });

  it('exports getClient', () => {
    expect(pkg.getClient).toBeDefined();
    expect(typeof pkg.getClient).toBe('function');
  });

  it('exports blackboard functions', () => {
    expect(typeof pkg.getBlackboard).toBe('function');
    expect(typeof pkg.getBlackboardSnapshot).toBe('function');
  });

  it('exports status functions', () => {
    expect(typeof pkg.getConnectionStatus).toBe('function');
    expect(typeof pkg.getTreeStatus).toBe('function');
  });

  it('exports createAction', () => {
    expect(typeof pkg.createAction).toBe('function');
  });

  it('exports event subscription functions', () => {
    expect(typeof pkg.onClientEvent).toBe('function');
    expect(typeof pkg.onTreeEvent).toBe('function');
  });

  it('exports createMockClient', () => {
    expect(typeof pkg.createMockClient).toBe('function');
  });
});
```

### Step 2: Run tests to verify they fail

Run: `pnpm --filter @cartographer/svelte test`
Expected: FAIL — `index.ts` is a placeholder

### Step 3: Implement index.ts

Update `packages/svelte/src/index.ts`:

```ts
// Component
export { default as Cartographer } from './provider.svelte';

// Context
export { getClient } from './context.js';

// Reactive getters
export { getConnectionStatus, getTreeStatus } from './status.svelte.js';
export { getBlackboard, getBlackboardSnapshot } from './blackboard.svelte.js';

// Factories
export { createAction } from './action.svelte.js';

// Event subscriptions
export { onClientEvent, onTreeEvent } from './events.svelte.js';

// Types
export type { TreeStatusInfo, ConnectionStatus } from './types.js';
export type { BlackboardRef, BlackboardSnapshotRef } from './blackboard.svelte.js';
export type { ConnectionStatusRef, TreeStatusRef } from './status.svelte.js';
export type { ActionRef } from './action.svelte.js';

// Test utilities
export { createMockClient } from './test-utils.svelte.js';
```

### Step 4: Run full test suite

Run: `pnpm --filter @cartographer/svelte test`
Expected: ALL tests pass across all test files

### Step 5: Verify build

Run: `pnpm --filter @cartographer/svelte build`

If `tsc` doesn't handle `.svelte` files, switch the build script to use `svelte-package` or another appropriate build tool. The key requirement is that the `dist/` output contains `.js`, `.d.ts`, and `.svelte` files that consumers can import.

### Step 6: Verify typecheck

Run: `pnpm --filter @cartographer/svelte typecheck`
Expected: No type errors

### Step 7: Run monorepo-wide tests

Run: `pnpm run test`
Expected: All packages pass, including the new `@cartographer/svelte` package

### Step 8: Commit

```bash
git add packages/svelte/src/index.ts packages/svelte/src/index.test.ts
git commit -m "feat(svelte): wire up package exports and verify integration"
```
