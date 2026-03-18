# React Integration Design

## Overview

Two new packages that give React applications a hooks-based interface to Cartographer's ActorServer. A lightweight client SDK handles HTTP+SSE communication; a React package wraps it in idiomatic hooks with efficient subscription-based re-rendering.

## Package Structure

Three packages in a monorepo layout:

| Package                | Role                                                   | Dependencies                                                   |
| ---------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| `cartographer`         | Server-side behavior tree framework (existing)         | `@anthropic-ai/claude-agent-sdk`, `zod`, `yaml`, `cron-parser` |
| `@cartographer/client` | Browser/Node client SDK (extracted from `src/client/`) | None (uses `fetch` + `EventSource`)                            |
| `@cartographer/react`  | React hooks wrapping the client                        | Peer: `react >=18`, `@cartographer/client`                     |

The main `cartographer` package does not need to re-export `@cartographer/client` for backward compatibility. We have no existing users, so we have flexibility to break backward compatability in favor of keeping things cleaner and easier.

## @cartographer/client

Extracted from the existing `src/client/index.ts` and `src/client/types.ts`. No behavioral changes — just a packaging move.

### Exports

- `createCartographerClient(baseUrl: string): CartographerClient` — factory function
- `CartographerClient` — interface (HTTP methods, SSE subscriptions, connect/disconnect)
- `ConflictError` — thrown on 409 Conflict

### API Surface

HTTP methods (work without SSE):

- `action(name, payload?)` — send an action message
- `write(key, value)` — write a blackboard value
- `send(msg)` — send any message type
- `interrupt()` — interrupt current processing
- `resume()` — clear held state

SSE-dependent methods:

- `actionAndWait(name, payload?)` — send action, wait for processing to complete
- `interruptAndAction(name, payload?)` — interrupt, wait for lock release, send action, wait for processing to complete

Query methods:

- `blackboard()` — GET current blackboard state
- `tree()` — GET tree structure
- `status()` — GET tree status

Event methods:

- `on(event, handler)` — subscribe to SSE event type (also supports `client:event` name dispatch)
- `onAny(handler)` — subscribe to all events
- `off(event, handler)` — unsubscribe
- `connect()` — open SSE connection
- `disconnect()` — close SSE connection

## @cartographer/react

### CartographerProvider

```tsx
<CartographerProvider url="http://localhost:3148">
  <App />
</CartographerProvider>
```

On mount:

1. Creates a `CartographerClient` via `createCartographerClient(url)`
2. Registers a `snapshot` event listener on the client
3. Calls `client.connect()` to open SSE
4. The `/api/events` endpoint sends a `snapshot` event (containing `{ blackboard, treeRootHash, lastMessageAt }`) as its first event on every connection — the store initializes from this snapshot
5. Subsequent SSE events update the store incrementally

On unmount:

1. Calls `client.disconnect()`

The provider renders no UI — it only provides context.

### Hook API

#### `useBlackboard<T>(key: string): [T | undefined, (value: T) => Promise<void>]`

Subscribes to a single blackboard key. Returns a `[value, setter]` tuple.

- The setter calls `client.write(key, value)` over HTTP
- The local store updates when the SSE `blackboard:write` echo arrives (no optimistic update)
- Only re-renders when this specific key's value changes (shallow comparison)
- Uses `useSyncExternalStore` with per-key subscription granularity

```tsx
const [name, setName] = useBlackboard<string>("user:name");
```

#### `useBlackboardSnapshot(): Record<string, unknown>`

Returns the entire blackboard state. Re-renders on any key change. Prefer `useBlackboard(key)` for targeted subscriptions.

#### `useTreeStatus(): TreeStatusInfo`

Subscribes to `tree:tick` SSE events. Returns the latest tick result:

```ts
interface TreeStatusInfo {
  status: string; // 'success' | 'failure' | 'running'
  durationMs: number;
  localTickCount: number; // client-side counter, incremented on each tree:tick event
}
```

The `tree:tick` SSE event payload contains `{ tree, status, durationMs }`. The store maintains a local tick counter that increments on each event. This counter resets on reconnect. For authoritative tick/cycle counts, use `useClient()` and call `client.status()` directly.

Re-renders after each tick.

#### `useAction(name: string): { send, sendAndWait, pending }`

Provides functions to send actions to the tree, with pending state tracking.

- `send(payload?): Promise<{ id: string }>` — fires the action, resolves with message ID. Sets `pending = true` until the message is processed (via `message:processed` or `message:failed` SSE events). Requires an active SSE connection for `pending` to clear — without SSE, `pending` stays `true` indefinitely.
- `sendAndWait(payload?): Promise<{ messageId: string; treeStatus: string }>` — fires the action and waits for tree processing to complete. Requires SSE.
- `pending: boolean` — `true` while a sent action is being processed. Cleared by SSE events, not the HTTP response.

```tsx
const review = useAction("submit_review");

<button onClick={() => review.send({ rating: 5 })} disabled={review.pending}>
  Submit
</button>;
```

#### `useClientEvent(name: string, handler: (data: unknown) => void): void`

Subscribes to named events from `EmitToClientNode` (delivered via `client:event` SSE events). The handler is ref-stable (no stale closure issues). For side effects, not state.

```tsx
useClientEvent("ui:show_confirmation", (data) => {
  setConfirmation(data as ConfirmationRequest);
});
```

#### `useTreeEvent(type: string, handler: (data: unknown) => void): void`

Subscribes to any SSE event type (`node:enter`, `agent:text`, `tree:tick`, etc.). Same ref-stable handler pattern. For observability and debugging use cases.

#### `useConnectionStatus(): 'connecting' | 'connected' | 'disconnected'`

Returns the current SSE connection state. Useful for showing connection status banners.

#### `useClient(): CartographerClient`

Escape hatch — returns the raw client instance for anything the hooks don't cover. The instance is stable across renders.

### Sync Store

An internal (not exported) store that bridges SSE events to React's `useSyncExternalStore`.

**State shape:**

```ts
interface SyncStoreState {
  blackboard: Record<string, unknown>;
  blackboardVersions: Record<string, number>; // per-key change counter
  treeStatus: TreeStatusInfo | null;
  connectionStatus: "connecting" | "connected" | "disconnected";
}
```

**Behaviors:**

- **Initialization**: On connect, the `snapshot` SSE event populates the blackboard and resets version counters. No separate HTTP fetch is needed.
- **Incremental updates**: `blackboard:write` SSE events update only the affected key and bump its version counter. `tree:tick` events replace the status slice and increment the local tick counter.
- **Subscription granularity**: `useBlackboard('user:name')` subscribes with a selector that checks the version counter for that key, so `useSyncExternalStore` can cheaply skip re-renders for unrelated keys.
- **Reconnection**: `EventSource` auto-reconnects natively. On each new connection, the `/api/events` endpoint sends a fresh `snapshot` event containing the current blackboard state — the store replaces its entire state from this snapshot. Any incremental SSE events that follow bring it up to date. The `last-event-id` header is passed to the server's `readEvents()` but does not guarantee gap-free replay, so the snapshot is the primary rehydration mechanism.

### Error Handling

- **Connection loss**: `EventSource` reconnects automatically. Connection state is exposed via `useConnectionStatus()` so the UI can show feedback.
- **ConflictError (409)**: Propagated to the caller from `useAction.send()`, `useAction.sendAndWait()`, and the `useBlackboard` setter. All three call HTTP endpoints that can return 409 when the server is processing another message. No automatic retry — the component decides how to handle it (show a message, use `interruptAndAction` via `useClient()`, etc.).
- **Provider missing**: Hooks throw a descriptive error if used outside a `CartographerProvider`.

## Data Flow Summary

| Pattern    | Flow                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| **Read**   | ActorServer → SSE `blackboard:write` → SyncStore → `useSyncExternalStore` → Component                  |
| **Write**  | Component → `useBlackboard` setter → `client.write()` → HTTP POST → ActorServer → SSE echo → SyncStore |
| **Event**  | `EmitToClientNode` → SSE `client:event` → `useClientEvent` handler → Component                         |
| **Action** | Component → `useAction.send()` → HTTP POST → ActorServer → `ActionReceivedNode` receives               |

## Non-Goals

- Pre-built UI components (blackboard inspector, event feed, tree visualizer) — hooks only
- Client-side behavior tree execution
- Optimistic blackboard updates — the server is the single source of truth
- Framework-agnostic abstractions — this is React-specific by design
