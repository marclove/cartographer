# Actor API Reference

## TreeActor

Transient per-message processor. Created per request, processes one message, discarded.

```typescript
import { TreeActor } from 'cartographer';
```

### TreeActorOptions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `createTree` | `() => BehaviorTree` | (required) | Factory that creates a fresh tree for each message. |
| `stateStore` | `StateStore` | (required) | Backing store for state persistence. |
| `stateKey` | `string` | (required) | Key under which session state is stored. |
| `topologyPolicy` | `'fail' \| 'reset'` | `'fail'` | What to do when stored root hash doesn't match the factory's tree. |

### Methods

#### `process(msg: ActorMessage): Promise<ProcessResult>`

Loads state, hydrates tree, applies message, runs to completion, serializes, saves. Returns `{ treeStatus, error? }` where `treeStatus` is `NodeStatus` (`'success'`, `'failure'`, `'running'`) or `'error'` (for signal handling).

---

## ActorServer

HTTP server wrapping TreeActor with REST and SSE endpoints.

```typescript
import { ActorServer } from 'cartographer';
```

### ActorServerOptions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `createTree` | `() => BehaviorTree` | (required) | Tree factory function. |
| `stateStore` | `StateStore` | `InMemoryStateStore` | Backing store. |
| `port` | `number` | `PORT` env or `3148` | Listen port. |
| `context` | `Record<string, unknown>` | `{}` | Injected into blackboard as `context:*` on init. |
| `topologyPolicy` | `'fail' \| 'reset'` | `'fail'` | Topology mismatch handling. |

### Methods

#### `start(): Promise<{ port: number }>`

Starts the HTTP server. Returns the actual listening port.

#### `stop(): Promise<void>`

Gracefully shuts down the server.

---

## ActorMessage

```typescript
type ActorMessage = TickMessage | ActionMessage | WriteMessage | SignalMessage;

interface TickMessage    { type: 'tick'; id?: string }
interface ActionMessage  { type: 'action'; name: string; payload?: unknown; id?: string }
interface WriteMessage   { type: 'write'; key: string; value: unknown; id?: string }
interface SignalMessage   { type: 'signal'; signal: 'stop' | 'reset' | 'abort'; id?: string }
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

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `redis` | ioredis instance | (required) | Redis connection. |
| `keyPrefix` | `string` | `'cartographer:'` | Prefix for all Redis keys. |
| `maxEvents` | `number` | `1000` | Max events per stream (XTRIM MAXLEN). |

Requires `ioredis` as a peer dependency.

---

## generateMessageId

```typescript
import { generateMessageId } from 'cartographer';
const id = generateMessageId(); // 'msg-1710000000000-a1b2c3'
```

Generates a unique message ID with `msg-` prefix, timestamp, and random suffix.
