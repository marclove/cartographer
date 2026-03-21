# Actor API Reference

## TreeActor

Transient per-message processor. Created per request, processes one message, discarded.

```typescript
import { TreeActor } from "cartographer";
```

### TreeActorOptions

| Field            | Type                 | Default    | Description                                                        |
| ---------------- | -------------------- | ---------- | ------------------------------------------------------------------ |
| `createTree`     | `() => BehaviorTree` | (required) | Factory that creates a fresh tree for each message.                |
| `stateStore`     | `StateStore`         | (required) | Backing store for state persistence.                               |
| `stateKey`       | `string`             | (required) | Key under which session state is stored.                           |
| `topologyPolicy` | `'fail' \| 'reset'`  | `'fail'`   | What to do when stored root hash doesn't match the factory's tree. |

### Methods

#### `process(msg: ActorMessage): Promise<ProcessResult>`

Loads state, hydrates tree, applies message, runs to completion, serializes, saves.

**ProcessResult:**

| Field         | Type                    | Description                                                                                                 |
| ------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `treeStatus`  | `NodeStatus \| 'error'` | Final tree status. `'running'` when suspended or interrupted. `'error'` for signal handling.                |
| `error`       | `string?`               | Error description (for signal handling or processing errors).                                               |
| `interrupted` | `boolean?`              | `true` when the processing loop was interrupted via `requestInterrupt()`. State is saved with `held: true`. |
| `held`        | `boolean?`              | `true` when a tick message was skipped because the tree is held.                                            |

#### `requestInterrupt(): void`

Signals the in-progress processing loop to interrupt. Safe to call at any time. If no processing is active, this is a no-op. See [Interrupts](../guide-app-server.md#interrupts).

---

## ActorServer

HTTP server wrapping TreeActor with REST and SSE endpoints.

```typescript
import { ActorServer } from "cartographer";
```

### ActorServerOptions

| Field            | Type                      | Default              | Description                                      |
| ---------------- | ------------------------- | -------------------- | ------------------------------------------------ |
| `createTree`     | `() => BehaviorTree`      | (required)           | Tree factory function.                           |
| `stateStore`     | `StateStore`              | `InMemoryStateStore` | Backing store.                                   |
| `port`           | `number`                  | `PORT` env or `3148` | Listen port.                                     |
| `context`        | `Record<string, unknown>` | `{}`                 | Injected into blackboard as `context:*` on init. |
| `topologyPolicy` | `'fail' \| 'reset'`       | `'fail'`             | Topology mismatch handling.                      |

### Methods

#### `start(): Promise<{ port: number }>`

Starts the HTTP server. Returns the actual listening port.

#### `stop(): Promise<void>`

Gracefully shuts down the server.

---

## ActorMessage

```typescript
type ActorMessage = TickMessage | ActionMessage | WriteMessage | SignalMessage;

interface TickMessage {
  type: "tick";
  id?: string;
}
interface ActionMessage {
  type: "action";
  name: string;
  payload?: unknown;
  id?: string;
}
interface WriteMessage {
  type: "write";
  key: string;
  value: unknown;
  id?: string;
}
interface SignalMessage {
  type: "signal";
  signal: "stop" | "reset" | "abort" | "resume";
  id?: string;
}
```

---

## StateStore Interface

```typescript
interface StateStore {
  getState(key: string): Promise<TreeSessionState | null>;
  saveState(key: string, state: TreeSessionState): Promise<void>;
  deleteState(key: string): Promise<void>;
  listKeys(): Promise<string[]>;
  acquireLock(key: string, requestId: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string, requestId: string): Promise<void>;
  appendEvents(key: string, events: TreeEvent[]): Promise<void>;
  readEvents(key: string, lastEventId?: string): AsyncIterable<TreeEvent>;
}
```

### TreeSessionState

```typescript
interface TreeSessionState {
  blackboard: Record<string, unknown>;
  treeState: SerializedTreeState;
  createdAt: number;
  lastMessageAt: number;
  held?: boolean; // true after interrupt — tick messages are no-ops while held
}
```

### TreeEvent

```typescript
interface TreeEvent {
  id: string;
  type: string;
  data: unknown;
  timestamp: number;
}
```

---

## InMemoryStateStore

```typescript
import { InMemoryStateStore } from 'cartographer';
const store = new InMemoryStateStore({ maxEvents?: number });
```

In-memory implementation for local development. State is lost on process restart.

---

## RedisStateStore

```typescript
import { RedisStateStore } from 'cartographer';
const store = new RedisStateStore({ redis, keyPrefix?, maxEvents? });
```

| Field       | Type             | Default           | Description                           |
| ----------- | ---------------- | ----------------- | ------------------------------------- |
| `redis`     | ioredis instance | (required)        | Redis connection.                     |
| `keyPrefix` | `string`         | `'cartographer:'` | Prefix for all Redis keys.            |
| `maxEvents` | `number`         | `1000`            | Max events per stream (XTRIM MAXLEN). |

Requires `ioredis` as a peer dependency.

---

## Message Event Types

```typescript
import type { MessageProcessedEvent, MessageInterruptedEvent, MessageFailedEvent } from "cartographer";
```

| Type                      | Fields                                      | Description                                                       |
| ------------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| `MessageProcessedEvent`   | `{ messageId: string; treeStatus: string }` | Emitted when processing completes.                                |
| `MessageInterruptedEvent` | `{ messageId: string }`                     | Emitted when processing is interrupted via `POST /api/interrupt`. |
| `MessageFailedEvent`      | `{ messageId: string; error: string }`      | Emitted when processing throws an error.                          |

---

## ActorServer Endpoints

In addition to the REST and SSE endpoints documented in the [Application Server guide](../guide-app-server.md#endpoints), `ActorServer` provides two control endpoints that bypass the processing lock:

#### `POST /api/interrupt`

Interrupts the active processing loop. Returns `{ interrupted: true, messageId }` when processing was active, or `{ interrupted: false }` when idle.

#### `POST /api/resume`

Clears the held state. Returns `{ resumed: true }` when the tree was held, or `{ resumed: false }` when it was not.

---

## generateMessageId

```typescript
import { generateMessageId } from "cartographer";
const id = generateMessageId(); // 'msg-1710000000000-a1b2c3'
```

Generates a unique message ID with `msg-` prefix, timestamp, and random suffix.
