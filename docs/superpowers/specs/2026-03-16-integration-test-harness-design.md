# Integration Test Harness Design

## Problem

The existing integration tests in `src/__integration__/` exercise tree-level behavior (ticking, composites, decorators, strategies) but predate the actor framework stack: `TreeActor`, `ActorServer`, `StateStore`, and the `CartographerClient` SDK. There are no tests that exercise the full client-to-server-to-tree pipeline.

Setting up a full-stack test requires booting an `ActorServer` on an ephemeral port, creating and connecting a `CartographerClient`, and tearing both down cleanly. This boilerplate should live in a shared harness so individual test files stay focused on the scenario they verify.

## Design

### Harness API

A single function `setupTest` is added to `src/__integration__/helpers.ts`:

```typescript
interface TestHarness {
  server: ActorServer;
  client: CartographerClient;
  port: number;
  teardown(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

type TestOptions = Omit<ActorServerOptions, 'port'>;

async function setupTest(options: TestOptions): Promise<TestHarness>;
```

### Setup

`setupTest` does the following:

1. Creates an `ActorServer` with the caller's options, overriding `port` to `0` for ephemeral port assignment.
2. Calls `await server.start()` to bind and get the assigned port.
3. Creates a client via `createCartographerClient(`http://localhost:${port}`)`.
4. Calls `client.connect()` to open the SSE connection.
5. Waits for the initial `snapshot` SSE event before returning. This ensures the SSE stream is fully established and methods like `actionAndWait()` work immediately. Uses a short timeout (e.g., 2s) and throws if the snapshot never arrives.
6. Returns a `TestHarness` object.

### Teardown

Both `teardown()` and `[Symbol.asyncDispose]()` point to the same cleanup:

1. `client.disconnect()` — closes the SSE EventSource.
2. `await server.stop()` — closes the HTTP server.

The `Symbol.asyncDispose` implementation enables `await using` syntax:

```typescript
it('tick completes a simple tree', async () => {
  await using harness = await setupTest({
    createTree: () => new BehaviorTree({ name: 'test', root: myNode }),
  });
  const result = await harness.client.actionAndWait('approve');
  expect(result.treeStatus).toBe('success');
});
```

### TypeScript Configuration

`tsconfig.json` must add `"esnext.disposable"` to the `lib` array so TypeScript recognizes `Symbol.asyncDispose`. This is a type-only change — Node 22+ has runtime support, and vitest does not use the compiled output.

```json
"lib": ["ES2022", "esnext.disposable"]
```

### Node Flags

The `CartographerClient` relies on `globalThis.EventSource`, which requires `--experimental-eventsource` in Node. The `test:integration` script in `package.json` must be updated to include this flag:

```json
"test:integration": "NODE_OPTIONS=--experimental-eventsource vitest run --project integration"
```

Without this, `connect()` silently no-ops and any test using `actionAndWait()` or `interruptAndAction()` will hang.

### Test File Conventions

Full-stack integration tests are one test per file, named after the functionality being verified (not the object under test). Examples:

- `src/__integration__/tick-completion.test.ts`
- `src/__integration__/action-resume-suspended.test.ts`
- `src/__integration__/interrupt-inflight.test.ts`

Each file imports `setupTest` from `./helpers`, constructs its own tree factory for the scenario, and uses `await using` for automatic cleanup. No shared state between tests.

## Scope

This spec covers only the `setupTest` harness function and the tsconfig change. The individual test files that use the harness are out of scope — they will be written as needed to cover specific full-stack scenarios.

## Dependencies

No new dependencies. Uses existing `ActorServer`, `createCartographerClient`, `BehaviorTree`, and `InMemoryStateStore` exports from the package.
