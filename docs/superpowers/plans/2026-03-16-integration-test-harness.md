# Integration Test Harness Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `setupTest` harness function to `src/__integration__/helpers.ts` that boots an `ActorServer` on an ephemeral port, creates and connects a `CartographerClient`, and provides automatic teardown via `Symbol.asyncDispose`.

**Architecture:** Single function added to existing helpers file. Uses `ActorServer` with `port: 0`, `createCartographerClient`, and waits for the SSE `snapshot` event before returning. Teardown disconnects client then stops server.

**Tech Stack:** TypeScript, vitest, existing Cartographer exports (`ActorServer`, `createCartographerClient`, `BehaviorTree`)

**Spec:** `docs/superpowers/specs/2026-03-16-integration-test-harness-design.md`

---

## File Structure

- **Modify:** `tsconfig.json` — add `esnext.disposable` to `lib`
- **Modify:** `package.json` — add `--experimental-eventsource` flag to `test:integration` script
- **Modify:** `src/__integration__/helpers.ts` — add `TestHarness` interface, `TestOptions` type, and `setupTest` function
- **Modify:** `src/__integration__/helpers.test.ts` — add test for `setupTest`

---

## Chunk 1: Configuration and Implementation

### Task 1: Add `esnext.disposable` to tsconfig lib

**Files:**
- Modify: `tsconfig.json:6`

- [ ] **Step 1: Update tsconfig.json**

Change the `lib` array from:
```json
"lib": ["ES2022"]
```
to:
```json
"lib": ["ES2022", "esnext.disposable"]
```

- [ ] **Step 2: Verify typecheck still passes**

Run: `npx tsc --noEmit`
Expected: No errors (existing code unaffected by the new lib)

- [ ] **Step 3: Commit**

```bash
git add tsconfig.json
git commit -m "chore: add esnext.disposable to tsconfig lib for Symbol.asyncDispose support"
```

---

### Task 2: Add `--experimental-eventsource` to test:integration script

**Files:**
- Modify: `package.json:25`

- [ ] **Step 1: Update the test:integration script**

Change from:
```json
"test:integration": "vitest run --project integration"
```
to:
```json
"test:integration": "NODE_OPTIONS=--experimental-eventsource vitest run --project integration"
```

This matches the pattern already used by `test`, `test:all`, and `test:watch`.

- [ ] **Step 2: Verify integration tests still pass**

Run: `npm run test:integration`
Expected: All existing integration tests pass (the flag has no effect on tests that don't use EventSource)

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add --experimental-eventsource flag to test:integration script"
```

---

### Task 3: Write the failing test for setupTest

**Files:**
- Modify: `src/__integration__/helpers.test.ts`

- [ ] **Step 1: Write the test**

Add the following to `src/__integration__/helpers.test.ts`:

```typescript
import { setupTest } from './helpers.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { NodeStatus } from '../types.js';
```

Add these at the top with the existing imports. Then add a new describe block after the existing ones:

```typescript
describe('setupTest', () => {
  it('boots server on ephemeral port and connects client', async () => {
    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'test',
          root: new ActionNode({
            name: 'noop',
            action: () => NodeStatus.SUCCESS,
          }),
        }),
    });

    expect(harness.port).toBeGreaterThan(0);
    expect(harness.server).toBeDefined();
    expect(harness.client).toBeDefined();

    // Client SSE is connected — actionAndWait should work without hanging
    const result = await harness.client.actionAndWait('tick');
    expect(result.treeStatus).toBe('success');
  });

  it('teardown stops server and disconnects client', async () => {
    const harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'test',
          root: new ActionNode({
            name: 'noop',
            action: () => NodeStatus.SUCCESS,
          }),
        }),
    });

    await harness.teardown();

    // Server is stopped — fetch should fail
    await expect(
      fetch(`http://localhost:${harness.port}/_platform/health`),
    ).rejects.toThrow();
  });

  it('passes options through to ActorServer', async () => {
    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'test',
          root: new ActionNode({
            name: 'read-ctx',
            action: (ctx) => {
              ctx.blackboard.set('result', ctx.blackboard.get('context:tenant'));
              return NodeStatus.SUCCESS;
            },
          }),
        }),
      context: { tenant: 'test-tenant' },
    });

    await harness.client.actionAndWait('tick');
    const bb = await harness.client.blackboard();
    expect(bb['result']).toBe('test-tenant');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration -- helpers`
Expected: FAIL — `setupTest` is not exported from helpers

---

### Task 4: Implement setupTest

**Files:**
- Modify: `src/__integration__/helpers.ts`

- [ ] **Step 1: Add imports to helpers.ts**

Add these imports at the top of `src/__integration__/helpers.ts`:

```typescript
import { ActorServer } from '../server/actor-server.js';
import type { ActorServerOptions } from '../server/actor-server.js';
import { createCartographerClient } from '../client/index.js';
import type { CartographerClient } from '../client/types.js';
```

- [ ] **Step 2: Add the TestHarness interface, TestOptions type, and setupTest function**

Add the following at the bottom of `src/__integration__/helpers.ts`:

```typescript
export interface TestHarness {
  server: ActorServer;
  client: CartographerClient;
  port: number;
  teardown(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export type TestOptions = Omit<ActorServerOptions, 'port'>;

export async function setupTest(options: TestOptions): Promise<TestHarness> {
  const server = new ActorServer({ ...options, port: 0 });
  const { port } = await server.start();

  const client = createCartographerClient(`http://localhost:${port}`);

  // Wait for the SSE snapshot event to confirm the connection is live.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('setupTest: SSE snapshot not received within 2s')), 2000);
    client.on('snapshot', () => {
      clearTimeout(timeout);
      resolve();
    });
    client.connect();
  });

  const teardown = async () => {
    client.disconnect();
    await server.stop();
  };

  return {
    server,
    client,
    port,
    teardown,
    [Symbol.asyncDispose]: teardown,
  };
}
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npm run test:integration -- helpers`
Expected: All tests pass, including the three new `setupTest` tests

- [ ] **Step 4: Run the full integration suite to check for regressions**

Run: `npm run test:integration`
Expected: All tests pass

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/__integration__/helpers.ts src/__integration__/helpers.test.ts
git commit -m "feat: add setupTest harness for full-stack integration testing"
```
