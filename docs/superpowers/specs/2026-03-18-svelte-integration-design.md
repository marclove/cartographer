# Svelte Integration Design

## Overview

A new `@cartographer/svelte` package that gives Svelte 5 applications a runes-based interface to Cartographer's ActorServer. Wraps `@cartographer/client` with idiomatic Svelte 5 reactivity — fine-grained `$state`/`$derived` bindings, automatic lifecycle management, and per-key blackboard subscriptions.

## Package Structure

| Package                | Role                                           | Dependencies                                      |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------- |
| `cartographer`         | Server-side behavior tree framework (existing) | `@anthropic-ai/claude-agent-sdk`, `zod`, etc.     |
| `@cartographer/client` | Browser/Node client SDK (existing)             | None (`fetch` + `EventSource`)                    |
| `@cartographer/react`  | React hooks wrapping the client (existing)     | Peer: `react >=18`, `@cartographer/client`        |
| `@cartographer/svelte` | Svelte 5 runes wrapping the client (new)       | Peer: `svelte ^5`, `@cartographer/client ^0.1.0`  |

## File Layout

```
packages/svelte/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts              # Re-exports public API
    provider.svelte        # <Cartographer> wrapper component
    state.svelte.ts        # Internal CartographerState class (runes)
    blackboard.svelte.ts   # getBlackboard, getBlackboardSnapshot
    status.svelte.ts       # getConnectionStatus, getTreeStatus
    action.svelte.ts       # createAction
    events.svelte.ts       # onClientEvent, onTreeEvent
    context.ts             # Context key + getClient helper
    types.ts               # TreeStatusInfo, ConnectionStatus
    test-utils.svelte.ts   # createMockClient + createTestContext
```

Files that use runes (`$state`, `$derived`, `$effect`) use the `.svelte.ts` extension. Files with only plain TypeScript use `.ts`.

## Public API

### Exports

```ts
// Component
export { default as Cartographer } from './provider.svelte'

// Context
export { getClient } from './context.js'

// Reactive getters
export { getConnectionStatus, getTreeStatus } from './status.svelte.js'
export { getBlackboard, getBlackboardSnapshot } from './blackboard.svelte.js'

// Factories
export { createAction } from './action.svelte.js'

// Event subscriptions
export { onClientEvent, onTreeEvent } from './events.svelte.js'

// Types
export type { TreeStatusInfo, ConnectionStatus } from './types.js'

// Test utilities
export { createMockClient, createTestContext } from './test-utils.svelte.js'
```

### Types

```ts
interface TreeStatusInfo {
  status: string
  durationMs: number
  localTickCount: number
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'
```

Same types as `@cartographer/react`. Defined locally — no cross-package type dependency.

## `<Cartographer>` Provider

```svelte
<Cartographer url="http://localhost:3148">
  <App />
</Cartographer>
```

Props:
- `url?: string` — base URL; creates a client via `createCartographerClient(url)`
- `client?: CartographerClient` — bring your own client (overrides `url`)
- `children: Snippet` — Svelte 5 snippet for child content

On mount:
1. Creates `CartographerClient` (if `url` provided) or uses the supplied `client`
2. Creates `CartographerState` instance
3. Calls `state.attach(client)` to wire up SSE event listeners
4. Calls `client.connect()` to open SSE
5. Sets both the client and state into Svelte context via `setContext`

On destroy:
1. Calls the cleanup function returned by `state.attach()` (detaches listeners, sets status to `disconnected`)
2. Calls `client.disconnect()`

The provider renders no UI — it only provides context and manages lifecycle. The component template is simply `{@render children()}`.

## `getClient()`

```ts
function getClient(): CartographerClient
```

Returns the raw `CartographerClient` instance from context. This is the escape hatch for capabilities the reactive wrappers don't cover — `interrupt()`, `resume()`, `interruptAndAction()`, `blackboard()`, `tree()`, `status()`, `onAny()`, etc.

Throws a descriptive error if called outside a `<Cartographer>` provider. The returned instance is stable for the lifetime of the provider.

```svelte
<script lang="ts">
  import { getClient } from '@cartographer/svelte'

  const client = getClient()

  async function handleInterrupt() {
    await client.interrupt()
  }
</script>
```

## Internal Reactive State

`CartographerState` is an internal class (not exported) that holds all reactive state using Svelte 5 runes.

```ts
class CartographerState {
  connectionStatus = $state<ConnectionStatus>('connecting')

  blackboardEntries = $state<Record<string, unknown>>({})
  blackboardVersions = $state<Record<string, number>>({})
  globalVersion = $state(0)

  treeStatus = $state<TreeStatusInfo | null>(null)

  attach(client: CartographerClient): () => void {
    // Registers handlers on client for SSE events
    // Returns cleanup function
  }
}
```

### SSE Event Handling

| SSE Event           | State Update                                                                       |
| ------------------- | ---------------------------------------------------------------------------------- |
| `snapshot`          | Replace entire blackboard, reset all version counters, reset `treeStatus` to null  |
| `blackboard:write`  | Update single key in `blackboardEntries`, bump that key's version + global version |
| `tree:tick`         | Update `treeStatus` with status/duration, increment `localTickCount`               |
| `connection:error`  | Set `connectionStatus` to `'connecting'` (readyState 0) or `'disconnected'` (readyState 2) |
| SSE `open`          | Set `connectionStatus` to `connected`                                              |

## Blackboard Functions

### `getBlackboard<T>(key: string): BlackboardRef<T>`

```ts
interface BlackboardRef<T> {
  readonly value: T | undefined
  set(newValue: T): Promise<void>
}
```

- `value` — `$derived` getter tracking the specific key in `blackboardEntries`. Only triggers reactivity when this key's version changes.
- `set(newValue)` — calls `client.write(key, newValue)`. No optimistic update; the value updates when the SSE `blackboard:write` event arrives.
- Per-key version tracking avoids spurious reactive updates when a snapshot re-confirms an unchanged value. Note: Svelte 5's deep reactivity on `$state` objects may make version maps unnecessary in practice — the explicit tracking is a conservative first approach that can be simplified later if benchmarks show no benefit.

### `getBlackboardSnapshot(): BlackboardSnapshotRef`

```ts
interface BlackboardSnapshotRef {
  readonly current: Record<string, unknown>
}
```

- `current` — `$derived` getter over the full `blackboardEntries` object. Updates on any key change or snapshot event.

### Usage

```svelte
<script lang="ts">
  import { getBlackboard, getBlackboardSnapshot } from '@cartographer/svelte'

  const username = getBlackboard<string>('user:name')
  const all = getBlackboardSnapshot()
</script>

<input value={username.value} oninput={(e) => username.set(e.currentTarget.value)} />
<pre>{JSON.stringify(all.current, null, 2)}</pre>
```

## Status Functions

### `getConnectionStatus(): ConnectionStatusRef`

```ts
interface ConnectionStatusRef {
  readonly current: ConnectionStatus
}
```

`$derived` getter over `CartographerState.connectionStatus`.

### `getTreeStatus(): TreeStatusRef`

```ts
interface TreeStatusRef {
  readonly current: TreeStatusInfo | null
}
```

`$derived` getter over `CartographerState.treeStatus`. Returns `null` before the first `tree:tick` event and resets to `null` on snapshot (reconnect).

### Usage

```svelte
<script lang="ts">
  import { getConnectionStatus, getTreeStatus } from '@cartographer/svelte'

  const conn = getConnectionStatus()
  const tree = getTreeStatus()
</script>

<span class="status">{conn.current}</span>
{#if tree.current}
  <span>Tick #{tree.current.localTickCount} — {tree.current.status}</span>
{/if}
```

## Action Function

### `createAction(name: string): ActionRef`

```ts
interface ActionRef {
  readonly pending: boolean
  send(payload?: unknown): Promise<{ id: string }>
  sendAndWait(payload?: unknown): Promise<{ messageId: string; treeStatus: string }>
}
```

- `pending` — `$state` backed, reactive. `true` while any send is in flight or awaiting completion.
- `send(payload?)` — calls `client.action(name, payload)`. Tracks in-flight count + pending message IDs. Cleared when `message:processed` or `message:failed` SSE events arrive for the tracked ID. Handles concurrent sends correctly (same logic as React's `useAction`).
- `sendAndWait(payload?)` — calls `client.actionAndWait(name, payload)`. Sets pending around the full round-trip.
- The `message:processed` and `message:failed` SSE listeners are registered once at creation time and filter incoming events by tracked message IDs. Cleaned up via `onDestroy`.

### Usage

```svelte
<script lang="ts">
  import { createAction } from '@cartographer/svelte'

  const review = createAction('submit_review')
</script>

<button disabled={review.pending} onclick={() => review.send({ rating: 5 })}>
  {review.pending ? 'Submitting...' : 'Submit'}
</button>
```

## Event Subscriptions

### `onClientEvent(name: string, handler: (data: unknown) => void): void`

Subscribes to named events from `EmitToClientNode` (delivered via `client:event` SSE channel). The client SDK's `on()` method already dispatches `client:event` payloads by their `name` field, so `onClientEvent('notification', handler)` is implemented as `client.on('notification', handler)` — no additional filtering is needed in the Svelte layer. Auto-cleans up on component destroy via `onDestroy`.

### `onTreeEvent(type: string, handler: (data: unknown) => void): void`

Subscribes to any SSE event type (`node:enter`, `node:exit`, `tree:tick`, etc.). Auto-cleans up on component destroy via `onDestroy`.

Both functions:
- Read `CartographerClient` from context
- Store the handler in a mutable reference so the subscription doesn't re-register when the handler closure changes
- Must be called during component initialization (same constraint as Svelte's `onMount`/`onDestroy`)

### Usage

```svelte
<script lang="ts">
  import { onClientEvent, onTreeEvent } from '@cartographer/svelte'

  let lastNode = $state('')

  onTreeEvent('node:enter', (data) => {
    lastNode = data.name
  })

  onClientEvent('notification', (data) => {
    console.log('got notification:', data)
  })
</script>

<p>Last entered node: {lastNode}</p>
```

## Testing

### `createMockClient()`

Same contract as React's mock: all `CartographerClient` methods are `vi.fn()` with sensible defaults, plus an `emit(event, data)` helper for simulating SSE events. Re-implemented locally — no test dependency on `@cartographer/react`.

### `createTestContext(overrides?)`

```ts
function createTestContext(overrides?: Partial<CartographerClient>): {
  client: CartographerClient & { emit(event: string, data: unknown): void }
  state: CartographerState  // exposed only through this test utility, not as a general public export
}
```

Creates a mock client and a `CartographerState` instance wired together. For unit-testing reactive functions without rendering a full component tree. `CartographerState` is accessible only through this test utility path — it is not part of the public API.

Tests use `@testing-library/svelte` for component-level tests with a wrapper that provides context, or `createTestContext()` for direct state/function testing.

## Error Handling

- **Provider missing**: `getClient()`, `getConnectionStatus()`, `getBlackboard()`, `getTreeStatus()`, `createAction()`, `onClientEvent()`, `onTreeEvent()` all throw a descriptive error if called outside a `<Cartographer>` provider.
- **HTTP errors**: `createAction().send()`, `.sendAndWait()`, and `getBlackboard().set()` propagate errors from the client as rejected promises. `ConflictError` (409) is not retried automatically.
- **Connection loss**: `EventSource` reconnects automatically. Connection state is exposed via `getConnectionStatus()` so the UI can show feedback. On reconnect, the server sends a fresh `snapshot` event to rehydrate state.

## Data Flow

| Pattern    | Flow                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| **Read**   | ActorServer → SSE `blackboard:write` → CartographerState → `$derived` → Component                           |
| **Write**  | Component → `getBlackboard().set()` → `client.write()` → HTTP POST → ActorServer → SSE echo → State update  |
| **Event**  | `EmitToClientNode` → SSE `client:event` → `onClientEvent` handler → Component                               |
| **Action** | Component → `createAction().send()` → HTTP POST → ActorServer → `ActionReceivedNode` receives               |

## Non-Goals

- Pre-built UI components (blackboard inspector, event feed, tree visualizer) — reactive primitives only
- Svelte 4 compatibility — Svelte 5 runes only
- Client-side behavior tree execution
- Optimistic blackboard updates — the server is the single source of truth
- Dashboard refactoring — the dashboard will consume this package in a future effort
- Reusing React's `SyncStore` — Svelte-native reactivity via `$state`/`$derived`
