# State API Reference

Persistence primitives for saving tree session state, acquiring distributed locks, and streaming events. Used by the [application server](../guide-app-server.md) to survive restarts and coordinate across replicas.

---

## StateStore (interface)

```typescript
import type { StateStore } from "cartographer";
```

Contract for state persistence, locking, and event streaming. Two implementations ship with the library: `InMemoryStateStore` for development and `RedisStateStore` for production.

### Methods

| Method         | Signature                                                           | Description                                                          |
| -------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `getState`     | `(key: string): Promise<TreeSessionState \| null>`                  | Retrieve the session state for a key, or `null` if none exists.      |
| `saveState`    | `(key: string, state: TreeSessionState): Promise<void>`             | Persist session state under the given key.                           |
| `deleteState`  | `(key: string): Promise<void>`                                      | Remove persisted state for a key.                                    |
| `listKeys`     | `(): Promise<string[]>`                                             | List all stored session keys.                                        |
| `acquireLock`  | `(key: string, requestId: string, ttlMs: number): Promise<boolean>` | Try to acquire a lock. Returns `true` on success, `false` if held.   |
| `releaseLock`  | `(key: string, requestId: string): Promise<void>`                   | Release a lock. Only succeeds if `requestId` matches the holder.     |
| `appendEvents` | `(key: string, events: TreeEvent[]): Promise<void>`                 | Append events to the stream for a key.                               |
| `readEvents`   | `(key: string, lastEventId?: string): AsyncIterable<TreeEvent>`     | Read events from a key's stream, yielding new events as they arrive. |

---

## TreeSessionState

```typescript
import type { TreeSessionState } from "cartographer";
```

Persisted snapshot of a tree's session, saved and restored by `TreeActor`.

| Field           | Type                      | Description                                                               |
| --------------- | ------------------------- | ------------------------------------------------------------------------- |
| `blackboard`    | `Record<string, unknown>` | Serialized blackboard key-value pairs.                                    |
| `treeState`     | `SerializedTreeState`     | Serialized node execution state (statuses, composite cycle state).        |
| `createdAt`     | `number`                  | Unix timestamp when the session was created.                              |
| `lastMessageAt` | `number`                  | Unix timestamp of the most recent message processed.                      |
| `held`          | `boolean` (optional)      | When `true`, the tree is held after interrupt — tick messages are no-ops. |

---

## TreeEvent

```typescript
import type { TreeEvent } from "cartographer";
```

A single persisted event from a tree session's event stream.

| Field       | Type      | Description                            |
| ----------- | --------- | -------------------------------------- |
| `id`        | `string`  | Unique event identifier.               |
| `type`      | `string`  | Event type (e.g. `"node:exit"`).       |
| `data`      | `unknown` | Event payload.                         |
| `timestamp` | `number`  | Unix timestamp when event was emitted. |

---

## InMemoryStateStore

```typescript
import { InMemoryStateStore } from "cartographer";
```

In-memory `StateStore` for development and testing. All data lives in `Map` objects and is lost when the process exits.

### Constructor

```typescript
new InMemoryStateStore(options?: { maxEvents?: number })
```

| Option      | Type     | Default | Description                                 |
| ----------- | -------- | ------- | ------------------------------------------- |
| `maxEvents` | `number` | `10000` | Maximum events retained per session stream. |

### Behavior

- `getState` / `saveState` deep-clone state via `structuredClone` so callers cannot accidentally mutate stored data.
- `deleteState` removes both the session state and its associated event buffer.
- `acquireLock` is a simple in-memory check — returns `false` if the key is already locked by a different `requestId`.
- `releaseLock` only releases if the `requestId` matches the current holder.
- `appendEvents` appends to an internal buffer, trims to `maxEvents`, and wakes any pending `readEvents` iterators.
- `readEvents` yields existing events past `lastEventId`, then async-yields new events as they arrive.

### Example

```typescript
import { InMemoryStateStore } from "cartographer";

const store = new InMemoryStateStore({ maxEvents: 500 });

// Use with TreeActor
const actor = new TreeActor({
  stateStore: store,
  // ...
});
```

---

## RedisStateStore

```typescript
import { RedisStateStore } from "cartographer";
```

Production-grade `StateStore` backed by Redis. Uses Redis strings for state, `SET NX PX` for distributed locking, and Redis Streams for event persistence.

### Constructor

```typescript
new RedisStateStore(options: RedisStateStoreOptions)
```

### RedisStateStoreOptions

| Field       | Type     | Required | Default           | Description                                   |
| ----------- | -------- | -------- | ----------------- | --------------------------------------------- |
| `redis`     | `Redis`  | Yes      | —                 | An existing `ioredis` client instance.        |
| `maxEvents` | `number` | No       | `10000`           | Maximum events retained per stream (`XTRIM`). |
| `keyPrefix` | `string` | No       | `"cartographer:"` | Prefix applied to all Redis keys.             |

### Key Layout

All Redis keys are prefixed with `keyPrefix` (default `cartographer:`):

| Pattern                | Redis Type | Purpose               |
| ---------------------- | ---------- | --------------------- |
| `{prefix}state:{key}`  | String     | JSON-serialized state |
| `{prefix}lock:{key}`   | String     | Distributed lock      |
| `{prefix}events:{key}` | Stream     | Event stream          |

### Behavior

- `acquireLock` uses `SET key requestId NX PX ttlMs` for distributed locking with automatic expiry.
- `releaseLock` uses a Lua script to atomically verify the `requestId` before deleting the key.
- `appendEvents` pipelines `XADD` and `XTRIM MAXLEN ~maxEvents` for efficient stream writes.
- `readEvents` reads existing entries with `XRANGE`, then subscribes via `XREAD BLOCK` on a duplicate Redis connection. The duplicate connection is closed automatically when the iterator returns or throws.

### Methods

Implements all `StateStore` methods, plus:

| Method  | Signature           | Description                  |
| ------- | ------------------- | ---------------------------- |
| `close` | `(): Promise<void>` | Disconnect the Redis client. |

### Example

```typescript
import Redis from "ioredis";
import { RedisStateStore } from "cartographer";

const redis = new Redis();
const store = new RedisStateStore({
  redis,
  keyPrefix: "myapp:",
  maxEvents: 5000,
});

// Use with TreeActor
const actor = new TreeActor({
  stateStore: store,
  // ...
});

// Cleanup
await store.close();
```
