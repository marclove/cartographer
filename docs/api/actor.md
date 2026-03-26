# Actor API Reference

## MessageProcessor

Transient per-message processor. Created per request, processes one message, discarded.

```typescript
import { MessageProcessor } from "cartographer";
```

### MessageProcessorOptions

| Field            | Type                 | Default    | Description                                                        |
| ---------------- | -------------------- | ---------- | ------------------------------------------------------------------ |
| `createTree`     | `() => BehaviorTree` | (required) | Factory that creates a fresh tree for each message.                |
| `stateStore`     | `StateStore`         | (required) | Backing store for state persistence.                               |
| `stateKey`       | `string`             | (required) | Key under which session state is stored.                           |
| `topologyPolicy` | `'fail' \| 'reset'`  | `'fail'`   | What to do when stored root hash doesn't match the factory's tree. |
| `eventBridge`    | `EventBridge`        | —          | Optional bridge for streaming tree events to connected clients.    |

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

HTTP server wrapping MessageProcessor with REST and SSE endpoints. A thin wrapper over `createApp()`.

```typescript
import { ActorServer } from "cartographer";
```

### ActorServerOptions

`ActorServerOptions` extends `AppOptions` with one additional field:

| Field  | Type     | Default              | Description  |
| ------ | -------- | -------------------- | ------------ |
| `port` | `number` | `PORT` env or `3148` | Listen port. |

See [AppOptions](#appoptions) for the remaining fields (`createTree`, `stateStore`, `context`, `topologyPolicy`, `maxQueueDepth`).

### Properties

| Property         | Type                 | Description                                              |
| ---------------- | -------------------- | -------------------------------------------------------- |
| `app`            | `Hono`               | Underlying Hono application. Mountable via `app.fetch`.  |
| `stateStore`     | `StateStore`         | Persistence backend for state, locks, events, and queue. |
| `topologyPolicy` | `'fail' \| 'reset'`  | How topology changes between ticks are handled.          |
| `maxQueueDepth`  | `number`             | Maximum queued messages while processing.                |

### Methods

#### `start(): Promise<{ port: number }>`

Initializes state and starts the HTTP server. Returns the actual listening port.

#### `stop(): Promise<void>`

Gracefully shuts down the server.

#### `processMessage(msg: ActorMessage): Promise<ProcessResult | QueuedResult | null>`

Processes a message programmatically without going through the REST API. Returns `null` if the queue is full.

#### `bridgeTree(tree: BehaviorTree): void`

Subscribes to a tree's events and forwards them through the SSE pipeline. Use this when an external tree should stream events to connected SSE clients.

---

## Hono App Factory

### createApp

Factory function that creates the full actor Hono app with message processing, queue management, and SSE streaming.

```typescript
import { createApp } from "cartographer";
```

#### AppOptions

| Field            | Type                      | Default                                    | Description                                      |
| ---------------- | ------------------------- | ------------------------------------------ | ------------------------------------------------ |
| `createTree`     | `() => BehaviorTree`      | (required)                                 | Tree factory function.                           |
| `stateStore`     | `StateStore`              | `InMemoryStateStore`                       | Backing store.                                   |
| `context`        | `Record<string, unknown>` | `{}`                                       | Injected into blackboard as `context:*` on init. |
| `topologyPolicy` | `'fail' \| 'reset'`       | `'fail'`                                   | Topology mismatch handling.                      |
| `maxQueueDepth`  | `number`                  | `CARTOGRAPHER_MAX_QUEUE_DEPTH` env or `16` | Maximum queued messages.                         |
| `autoTick`       | `{ intervalMs: number }`  | —                                          | Enable auto-ticking at the specified interval.   |

#### AppHandle

| Field             | Type                                                              | Description                                        |
| ----------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `app`             | `Hono`                                                            | The Hono application with all routes mounted.      |
| `stateStore`      | `StateStore`                                                      | Resolved state store instance.                     |
| `topologyPolicy`  | `'fail' \| 'reset'`                                               | Resolved topology policy.                          |
| `maxQueueDepth`   | `number`                                                          | Resolved max queue depth.                          |
| `processMessage`  | `(msg: ActorMessage) => Promise<ProcessResult \| QueuedResult \| null>` | Process a message programmatically.          |
| `bridgeTree`      | `(tree: BehaviorTree) => void`                                    | Forward external tree events to SSE clients.       |
| `initializeState` | `() => Promise<void>`                                             | Initialize state store with tree factory defaults. |
| `drainQueue`      | `() => Promise<void>`                                             | Process the next queued message, if any.           |
| `closeSseClients` | `() => void`                                                      | Close all connected SSE clients.                   |
| `startAutoTick`   | `() => void`                                                      | Start the auto-tick interval (if `autoTick` was configured). |
| `stopAutoTick`    | `() => void`                                                      | Stop the auto-tick interval.                       |

---

## ActorMessage

```typescript
type ActorMessage = TickMessage | CommandMessage | WriteMessage | SignalMessage;

interface TickMessage {
  type: "tick";
  id?: string;
}
interface CommandMessage {
  type: "command";
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
  enqueueMessage(stateKey: string, message: ActorMessage, maxQueueDepth: number): Promise<{ position: number; queueSize: number }>;
  dequeueMessage(stateKey: string): Promise<ActorMessage | null>;
  getQueueSize(stateKey: string): Promise<number>;
  getQueuedMessages(stateKey: string): Promise<ActorMessage[]>;
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
import type {
  MessageQueuedEvent, MessageDequeuedEvent,
  MessageProcessedEvent, MessageInterruptedEvent, MessageFailedEvent,
} from "cartographer";
```

| Type                      | Fields                                      | Description                                                       |
| ------------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| `MessageQueuedEvent`      | `{ messageId: string; position: number }`   | Emitted when a message is enqueued because the server is busy.    |
| `MessageDequeuedEvent`    | `{ messageId: string }`                     | Emitted when a queued message begins processing.                  |
| `MessageProcessedEvent`   | `{ messageId: string; treeStatus: string }` | Emitted when processing completes.                                |
| `MessageInterruptedEvent` | `{ messageId: string }`                     | Emitted when processing is interrupted via `POST /api/interrupt`. |
| `MessageFailedEvent`      | `{ messageId: string; error: string }`      | Emitted when processing throws an error.                          |

---

## EventBridge

Bridges tree events to state persistence and SSE delivery. Used internally by `createApp()`.

```typescript
import { EventBridge } from "cartographer";
```

---

## generateMessageId

```typescript
import { generateMessageId } from "cartographer";
const id = generateMessageId(); // 'msg-1710000000000-a1b2c3'
```

Generates a unique message ID with `msg-` prefix, timestamp, and random suffix.
