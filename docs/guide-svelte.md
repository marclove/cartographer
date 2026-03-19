# Svelte Integration

`@cartographer/svelte` provides Svelte 5 bindings for the Cartographer client SDK. It connects your Svelte components to a running `ActorServer` via reactive state backed by Svelte runes, giving you live blackboard data, tree status, connection state, and action dispatching with zero manual event wiring.

This guide assumes you have a Cartographer `ActorServer` running. If you haven't set one up yet, read the [Actor Framework](guide-actor-framework.md) guide first.

---

## Prerequisites

- Svelte 5 (runes mode)
- A running Cartographer `ActorServer`

## Installation

```bash
npm install @cartographer/svelte @cartographer/client
```

`@cartographer/client` is a peer dependency — it provides the underlying `CartographerClient` that the Svelte bindings wrap.

---

## The `<Cartographer>` Provider

Every `@cartographer/svelte` function reads from Svelte context, so your component tree needs a `<Cartographer>` provider at the top. The provider creates a client, opens an SSE connection on mount, and disconnects on destroy.

```svelte
<!-- src/App.svelte -->
<script lang="ts">
  import { Cartographer } from '@cartographer/svelte';
  import Dashboard from './Dashboard.svelte';
</script>

<Cartographer url="http://localhost:3148">
  {#snippet children()}
    <Dashboard />
  {/snippet}
</Cartographer>
```

### Props

| Prop       | Type                    | Description |
|------------|-------------------------|-------------|
| `url`      | `string`                | Base URL of the `ActorServer`. A `CartographerClient` is created automatically. |
| `client`   | `CartographerClient`    | Bring-your-own client instance. When provided, `url` is ignored. Useful for testing or custom configuration. |
| `children` | `Snippet`               | Svelte 5 snippet rendered as child content. |

You must provide either `url` or `client`. The provider calls `client.connect()` on mount and `client.disconnect()` on destroy, so you do not need to manage the SSE lifecycle yourself.

---

## Reading Blackboard State

The blackboard is the shared key-value store that your behavior tree reads and writes. `@cartographer/svelte` offers two reactive accessors depending on whether you need a single key or the full object.

### `getBlackboard<T>(key)`

Returns a reactive ref for a single blackboard key. The `value` getter updates whenever the server sends a `blackboard:write` event for that key.

```svelte
<script lang="ts">
  import { getBlackboard } from '@cartographer/svelte';

  const greeting = getBlackboard<string>('greeting');
</script>

<p>Current greeting: {greeting.value ?? 'none'}</p>
```

The returned `BlackboardRef<T>` has two members:

| Member | Type | Description |
|--------|------|-------------|
| `value` | `T \| undefined` | The current value for the key, reactive. `undefined` if the key hasn't been written. |
| `set(newValue)` | `(T) => Promise<void>` | Writes the value to the server via HTTP. Not an optimistic update — `value` changes only after the server echoes the write back through SSE. |

Writing a value from a component:

```svelte
<script lang="ts">
  import { getBlackboard } from '@cartographer/svelte';

  const theme = getBlackboard<string>('config:theme');

  async function toggleTheme() {
    const next = theme.value === 'dark' ? 'light' : 'dark';
    await theme.set(next);
  }
</script>

<button onclick={toggleTheme}>
  Theme: {theme.value ?? 'loading...'}
</button>
```

### `getBlackboardSnapshot()`

Returns a reactive ref for the entire blackboard as a `Record<string, unknown>`. The `current` getter updates on every key change and on full snapshot events (e.g., on initial connection).

```svelte
<script lang="ts">
  import { getBlackboardSnapshot } from '@cartographer/svelte';

  const board = getBlackboardSnapshot();
</script>

<pre>{JSON.stringify(board.current, null, 2)}</pre>
```

Prefer `getBlackboard` when you only need one or two keys. `getBlackboardSnapshot` triggers a re-render on any blackboard change, which is useful for debug panels but wasteful for targeted UI.

---

## Connection and Tree Status

### `getConnectionStatus()`

Returns a reactive ref tracking the SSE connection lifecycle.

```svelte
<script lang="ts">
  import { getConnectionStatus } from '@cartographer/svelte';

  const conn = getConnectionStatus();
</script>

{#if conn.current === 'connected'}
  <span>Connected</span>
{:else if conn.current === 'connecting'}
  <span>Reconnecting...</span>
{:else}
  <span>Disconnected</span>
{/if}
```

The `current` value is one of `'connecting'`, `'connected'`, or `'disconnected'`. It starts as `'connecting'` and transitions to `'connected'` when the first `snapshot` SSE event arrives.

### `getTreeStatus()`

Returns a reactive ref for the most recent tree tick result.

```svelte
<script lang="ts">
  import { getTreeStatus } from '@cartographer/svelte';

  const tree = getTreeStatus();
</script>

{#if tree.current}
  <p>Status: {tree.current.status}</p>
  <p>Duration: {tree.current.durationMs}ms</p>
  <p>Ticks observed: {tree.current.localTickCount}</p>
{:else}
  <p>Waiting for first tick...</p>
{/if}
```

The `current` value is `null` until the first `tree:tick` SSE event arrives, and resets to `null` on reconnection (when a new snapshot is received). The `TreeStatusInfo` object contains:

| Field            | Type     | Description |
|------------------|----------|-------------|
| `status`         | `string` | Node status from the root tick — typically `"success"`, `"failure"`, or `"running"`. |
| `durationMs`     | `number` | Wall-clock duration of the tick in milliseconds. |
| `localTickCount` | `number` | Client-side tick counter, incremented on every `tree:tick` event. Resets on reconnect. |

---

## Dispatching Actions

`createAction` returns a reactive handle for sending named actions to the server. It tracks whether the action is still in flight or awaiting server-side completion.

```svelte
<script lang="ts">
  import { createAction } from '@cartographer/svelte';

  const approve = createAction('approve');
</script>

<button onclick={() => approve.send({ comment: 'Ship it' })} disabled={approve.pending}>
  {approve.pending ? 'Sending...' : 'Approve'}
</button>
```

The returned `ActionRef` has three members:

| Member | Type | Description |
|--------|------|-------------|
| `pending` | `boolean` | `true` while an HTTP request is in flight or a dispatched message hasn't received its `message:processed` / `message:failed` SSE event. Reactive. |
| `send(payload?)` | `(unknown?) => Promise<{ id }>` | Fires the action and returns the server-assigned message ID. `pending` remains `true` until the SSE settlement event arrives. |
| `sendAndWait(payload?)` | `(unknown?) => Promise<{ messageId, treeStatus }>` | Fires the action and waits for the server to finish processing. The promise resolves with the final tree status, or rejects if the server reports failure. |

### Fire-and-forget vs. await completion

Use `send` when the UI should update optimistically — the button disables via `pending` and re-enables when the server confirms completion through SSE.

Use `sendAndWait` when subsequent logic depends on the tree run finishing:

```svelte
<script lang="ts">
  import { createAction } from '@cartographer/svelte';

  const analyze = createAction('analyze');
  let result = $state<string | null>(null);

  async function runAnalysis() {
    const { treeStatus } = await analyze.sendAndWait({ document: 'some-doc-id' });
    result = treeStatus;
  }
</script>

<button onclick={runAnalysis} disabled={analyze.pending}>Analyze</button>
{#if result}
  <p>Tree finished with status: {result}</p>
{/if}
```

### Lifecycle

`createAction` registers `message:processed` and `message:failed` SSE listeners when called and removes them automatically when the component is destroyed. If the component unmounts while a `sendAndWait` promise is pending, the promise rejects with a `"Component unmounted"` error.

---

## Listening to Events

### `onClientEvent(name, handler)`

Subscribes to events emitted by `emitToClient` nodes on the server. The event name must match the name used in the server-side tree.

```svelte
<script lang="ts">
  import { onClientEvent } from '@cartographer/svelte';

  let findings = $state<unknown>(null);

  onClientEvent('ui:show_review', (data) => {
    findings = data;
  });
</script>

{#if findings}
  <pre>{JSON.stringify(findings, null, 2)}</pre>
{/if}
```

### `onTreeEvent(type, handler)`

Subscribes to raw SSE event types like `node:enter`, `node:exit`, or `tree:tick`. Use this for low-level tree lifecycle events not covered by the higher-level helpers.

```svelte
<script lang="ts">
  import { onTreeEvent } from '@cartographer/svelte';

  let tickLog = $state<string[]>([]);

  onTreeEvent('tree:tick', (data) => {
    const d = data as { status: string };
    tickLog = [...tickLog, d.status];
  });
</script>

<ul>
  {#each tickLog as entry}
    <li>{entry}</li>
  {/each}
</ul>
```

Both functions register their listener once during component initialization and tear it down on destroy. In Svelte 5 the `<script>` block runs only once, so the handler is captured at initialization time — close over `$state` variables inside the handler if you need dynamic behavior.

---

## Direct Client Access

When the reactive wrappers don't cover the operation you need, use `getClient()` to access the underlying `CartographerClient` directly.

```svelte
<script lang="ts">
  import { getClient } from '@cartographer/svelte';

  const client = getClient();

  async function interruptAndRedirect() {
    await client.interrupt();
    await client.action('redirect', { target: '/new-path' });
  }
</script>

<button onclick={interruptAndRedirect}>Redirect</button>
```

`getClient()` must be called during component initialization (top level of the `<script>` block), and only inside a `<Cartographer>` provider. It returns the same `CartographerClient` instance documented in the [Client SDK](guide-actor-framework.md#client-sdk) section of the Actor Framework guide.

---

## Full Example

This example ties together a provider, blackboard reading, action dispatching, and client event handling into a minimal review approval flow.

```svelte
<!-- src/App.svelte -->
<script lang="ts">
  import { Cartographer } from '@cartographer/svelte';
  import ReviewPanel from './ReviewPanel.svelte';
</script>

<Cartographer url="http://localhost:3148">
  {#snippet children()}
    <ReviewPanel />
  {/snippet}
</Cartographer>
```

```svelte
<!-- src/ReviewPanel.svelte -->
<script lang="ts">
  import {
    getBlackboard,
    getConnectionStatus,
    getTreeStatus,
    createAction,
    onClientEvent,
  } from '@cartographer/svelte';

  const conn = getConnectionStatus();
  const tree = getTreeStatus();
  const analysis = getBlackboard<{ summary: string }>('analysis');
  const approve = createAction('approve');
  const reject = createAction('reject');

  let findings = $state<unknown>(null);

  onClientEvent('ui:show_review', (data) => {
    findings = data;
  });
</script>

{#if conn.current !== 'connected'}
  <p>Connecting to server...</p>
{:else}
  <h2>Review Panel</h2>

  {#if findings}
    <section>
      <h3>Findings</h3>
      <pre>{JSON.stringify(findings, null, 2)}</pre>
    </section>
  {/if}

  {#if analysis.value}
    <p>Analysis: {analysis.value.summary}</p>
  {/if}

  <div>
    <button onclick={() => approve.send()} disabled={approve.pending}>
      {approve.pending ? 'Approving...' : 'Approve'}
    </button>
    <button onclick={() => reject.send()} disabled={reject.pending}>
      {reject.pending ? 'Rejecting...' : 'Reject'}
    </button>
  </div>

  {#if tree.current}
    <footer>
      Last tick: {tree.current.status} ({tree.current.durationMs}ms)
    </footer>
  {/if}
{/if}
```

---

## Testing

`@cartographer/svelte` exports two test utilities that let you test components without a running server.

### `createMockClient()`

Creates a mock `CartographerClient` with all methods stubbed via `vi.fn()`. The mock includes an `emit(event, data)` helper that dispatches synthetic SSE events to registered handlers.

```typescript
import { createMockClient } from '@cartographer/svelte';

const client = createMockClient();

// Simulate a server snapshot
client.emit('snapshot', { blackboard: { greeting: 'hello' } });

// Assert that action was called
await client.action('approve', { comment: 'LGTM' });
expect(client.action).toHaveBeenCalledWith('approve', { comment: 'LGTM' });
```

### `createTestContext(overrides?)`

Creates a mock client and a `CartographerState` already wired together. Use this to test reactive state transitions without rendering a full component tree.

```typescript
import { createTestContext } from '@cartographer/svelte';

const { client, state } = createTestContext();

// State starts at 'connecting'
expect(state.connectionStatus).toBe('connecting');

// Simulate connection
client.emit('snapshot', { blackboard: { count: 42 } });
expect(state.connectionStatus).toBe('connected');
expect(state.blackboardEntries).toEqual({ count: 42 });

// Simulate a blackboard write
client.emit('blackboard:write', { key: 'count', value: 43 });
expect(state.blackboardEntries.count).toBe(43);
```

You can pass `overrides` to customize individual method stubs:

```typescript
const { client } = createTestContext({
  action: vi.fn().mockRejectedValue(new Error('Server error')),
});
```

### Testing components

When testing Svelte components that use `@cartographer/svelte` functions, pass a mock client to the `<Cartographer>` provider:

```svelte
<!-- TestWrapper.svelte -->
<script lang="ts">
  import type { CartographerClient } from '@cartographer/client';
  import { Cartographer } from '@cartographer/svelte';
  import type { Snippet } from 'svelte';

  let { client, children }: { client: CartographerClient; children: Snippet } = $props();
</script>

<Cartographer {client}>
  {#snippet children()}
    {@render children()}
  {/snippet}
</Cartographer>
```

Then in your test:

```typescript
import { render } from '@testing-library/svelte';
import { createMockClient } from '@cartographer/svelte';
import TestWrapper from './TestWrapper.svelte';

const client = createMockClient();
const { getByTestId } = render(TestWrapper, { props: { client } });

// Simulate server events and assert against the rendered output
client.emit('snapshot', { blackboard: { status: 'ready' } });
```

---

## API at a Glance

| Export                   | Kind        | Description |
|--------------------------|-------------|-------------|
| `Cartographer`           | Component   | Provider that manages client lifecycle and context. |
| `getClient()`            | Function    | Returns the raw `CartographerClient` from context. |
| `getBlackboard<T>(key)`  | Function    | Reactive ref for a single blackboard key. |
| `getBlackboardSnapshot()`| Function    | Reactive ref for the full blackboard object. |
| `getConnectionStatus()`  | Function    | Reactive ref for SSE connection state. |
| `getTreeStatus()`        | Function    | Reactive ref for the latest tree tick result. |
| `createAction(name)`     | Function    | Reactive action handle with `send`, `sendAndWait`, and `pending`. |
| `onClientEvent(name, handler)` | Function | Subscribe to `emitToClient` events. |
| `onTreeEvent(type, handler)`   | Function | Subscribe to raw SSE event types. |
| `createMockClient()`     | Test utility | Mock client with `emit()` for simulating SSE events. |
| `createTestContext()`    | Test utility | Mock client + reactive state, pre-wired. |

All functions except `createMockClient` and `createTestContext` must be called during component initialization (top level of a `<script>` block) and inside a `<Cartographer>` provider.

---

## Where to Go Next

- [Actor Framework](guide-actor-framework.md) -- server-side setup, endpoints, and the processing model.
- [Client SDK API](api/client.md) -- full reference for `CartographerClient` methods.
- [Blackboard and Events](guide-blackboard-and-events.md) -- how blackboard state and events work at the tree level.
- [Testing Behavior Trees](guide-testing.md) -- patterns for testing the server-side trees your Svelte app connects to.
