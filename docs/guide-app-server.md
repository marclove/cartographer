# Application Server

The application server turns Cartographer's behavior trees into persistent, message-driven services. Instead of ticking a tree in a loop, you define a tree factory and let the server handle state persistence, HTTP endpoints, and client communication.

This guide covers the full stack: `TreeActor` for processing, `ActorServer` for HTTP, `StateStore` for persistence, and the client SDK for browser/Node.js consumers.

---

## Overview

A traditional Cartographer tree lives in memory and runs until its process ends. The application server changes this:

1. A **tree factory** creates a fresh tree for every incoming message.
2. **TreeActor** loads persisted state, hydrates the tree, processes one message to completion, then serializes and saves the result.
3. **ActorServer** wraps TreeActor with an HTTP server — REST endpoints for sending messages, SSE for real-time events, and read endpoints for inspecting state.
4. A **Client SDK** connects frontends to the server via fetch and EventSource.

The tree itself is *transient* — created per request, then discarded. The *state* is durable, stored in a `StateStore` (in-memory for development, Redis for production).

---

## Quick Start

```typescript
import {
  BehaviorTree,
  ActorServer,
  ActionNode,
  SequenceNode,
  SelectorNode,
  NodeStatus,
  actionReceived,
  untilSuccess,
  emitToClient,
} from 'cartographer';

const server = new ActorServer({
  createTree: () => new BehaviorTree({
    name: 'review-flow',
    root: new SequenceNode({
      name: 'main',
      children: [
        // Agent analyzes the document
        new ActionNode({
          name: 'analyze',
          action: async (ctx) => {
            ctx.blackboard.set('analysis', { summary: 'Looks good' });
            return NodeStatus.SUCCESS;
          },
        }),
        // Send findings to the client
        emitToClient('ui:show_review', (ctx) => ({
          findings: ctx.blackboard.get('analysis'),
        })),
        // Wait for user approval or rejection
        untilSuccess(
          new SelectorNode({
            name: 'wait-for-decision',
            children: [
              actionReceived('approve'),
              actionReceived('reject'),
            ],
          }),
        ),
      ],
    }),
  }),
  port: 3148,
});

await server.start();
console.log('ActorServer running on http://localhost:3148');
```

Then from a browser or Node.js client:

```typescript
import { createCartographerClient } from 'cartographer';

const client = createCartographerClient('http://localhost:3148');

// Start the tree
await client.send({ type: 'tick' });

// Read blackboard state
const bb = await client.blackboard();
console.log(bb.analysis); // { summary: 'Looks good' }

// Send a user action
await client.action('approve', { comment: 'Ship it' });
```

---

## TreeActor

`TreeActor` is the per-message processor. It is transient — created for each request, processes exactly one message, then discarded. You typically do not use it directly; `ActorServer` manages it internally.

### Processing Pipeline

For each message, `TreeActor.process()` runs this pipeline:

1. **Create tree** from the factory function.
2. **Load state** from the `StateStore` (blackboard values and serialized tree execution state).
3. **Restore** the tree's execution state using content-hash-based serialization.
4. **Apply the message** — write action payloads or blackboard values.
5. **Run to completion** — tick the tree repeatedly until it reaches a terminal status (`SUCCESS`/`FAILURE`) or suspends (`RUNNING` with no in-flight work).
6. **Serialize** tree state and blackboard.
7. **Save** back to the `StateStore`.

### Run to Completion

The `runToCompletion()` loop is the core of the processing model. It distinguishes between two kinds of `RUNNING`:

- **In-flight work** (`hasInflightWork() === true`): An `ActionNode` or `AgentNode` has an async operation in progress. The loop waits for it to settle via `settled()`, then ticks again.
- **Suspended** (`hasInflightWork() === false`): The tree returned `RUNNING` but nothing is in progress — typically because an `untilSuccess` or `actionReceived` node is waiting for external input. The loop exits.

```typescript
const actor = new TreeActor({
  createTree: () => myTreeFactory(),
  stateStore: myStore,
  stateKey: 'session-123',
});

const result = await actor.process({ type: 'tick' });
// result.treeStatus is 'success', 'failure', 'running' (suspended), or 'error' (signal handled)
```

### Message Types

| Type     | Fields                   | Effect                                          |
|----------|--------------------------|-------------------------------------------------|
| `tick`   | —                        | Ticks the tree with no additional input.        |
| `action` | `name`, `payload?`       | Writes `payload` to `actions:<name>` on the blackboard, then ticks. |
| `write`  | `key`, `value`           | Writes `value` to `key` on the blackboard, then ticks. |
| `signal` | `signal: 'stop'\|'reset'\|'abort'\|'resume'` | Resets or aborts the tree without ticking. `reset` calls `tree.reset()`, `abort` calls `tree.abort()`. `resume` clears the held state (see [Interrupts](#interrupts) below). `stop` is accepted but is currently a no-op. All signals return `{ treeStatus: 'error' }` without ticking. |

### Interrupts

When a long-running `AgentNode` is processing (seconds to minutes), the user may want to cancel the current work without losing progress. `interrupt` is a middle ground between doing nothing and a full `abort`:

| Operation     | Cancels in-flight work | Clears completedMap | Requires reset() | Tree afterward      |
|---------------|----------------------|--------------------|-----------------|--------------------|
| **abort**     | Yes                  | Yes                | Yes             | Dead (needs reset) |
| **interrupt** | Yes                  | No                 | No              | RUNNING, suspended |
| **do nothing**| No                   | No                 | No              | RUNNING, in-flight |

After interrupt, the tree is in the same state as a normal suspension point: `RUNNING` with `hasInflightWork() === false`. Sequence `completedMap` entries survive, so previously completed children are not re-executed.

#### How it works

`TreeActor` holds an internal `interruptController`. The `runToCompletion()` loop races `tree.settled()` against this interrupt signal. When interrupted:

1. `tree.interrupt()` is called — cancels in-flight SDK calls while preserving composite cycle state.
2. The tree is serialized and saved normally.
3. The state is marked as **held** (`held: true` in `TreeSessionState`).
4. The `ProcessResult` includes `{ interrupted: true, treeStatus: 'running' }`.

#### Held state

After interrupt, the tree enters a **held** state. This prevents the scheduler from immediately restarting the interrupted agent before the user has a chance to redirect.

While held:
- **`tick` messages** → no-op (returns `{ treeStatus: 'running', held: true }` without processing).
- **`action` / `write` messages** → clear held flag, then process normally.
- **`signal: resume`** → clear held flag without ticking (next scheduler tick resumes the agent).

#### What happens after interrupt

The interrupted agent's in-flight state is cleared. On the next deliberate user action:

- **"Cancel and move on"**: send an action that takes a different path (clears held, processes action).
- **"Cancel and redirect"**: send a `write` to update blackboard context (clears held, processes write, re-invokes agent on next tick).
- **"Just retry as-is"**: `POST /api/resume` (clears held), then the next scheduler tick resumes the agent.

```typescript
const actor = new TreeActor({
  createTree: () => myTreeFactory(),
  stateStore: myStore,
  stateKey: 'session-123',
});

// Start processing in the background
const processPromise = actor.process({ type: 'tick' });

// Interrupt from another context (e.g., HTTP handler)
actor.requestInterrupt();

const result = await processPromise;
// result.treeStatus === 'running'
// result.interrupted === true
```

---

## ActorServer

`ActorServer` wraps `TreeActor` with an HTTP server. It handles routing, JSON parsing, locking, and SSE event delivery.

### Configuration

```typescript
const server = new ActorServer({
  createTree: () => myTreeFactory(),  // Required: tree factory
  stateStore: new InMemoryStateStore(),  // Optional (default: InMemoryStateStore)
  port: 3148,                         // Optional (default: PORT env var or 3148)
  context: { tenantId: 'abc' },       // Optional: written to blackboard as context:*
  topologyPolicy: 'fail',             // Optional: 'fail' or 'reset' on tree shape change
});

const { port } = await server.start();
console.log(`Listening on port ${port}`);

// Graceful shutdown
await server.stop();
```

The `context` option injects key-value pairs into the blackboard on initialization, prefixed with `context:`. Use it to pass deployment metadata like tenant IDs.

`ActorServer` currently manages a single session with the hardcoded state key `'default'`. All state, locks, and events are stored under this key. Multi-session support is not yet available at the server level, though `TreeActor` accepts any `stateKey`.

### Endpoints

#### Read Endpoints

| Method | Path                | Description                                |
|--------|---------------------|--------------------------------------------|
| GET    | `/_platform/health` | Platform health check. Returns `{ status: "ok", uptime }`. |
| GET    | `/api/blackboard`   | Current blackboard state as JSON.          |
| GET    | `/api/status`       | Tree metadata: `lastMessageAt`, `treeRootHash`. |
| GET    | `/api/tree`         | Tree structure: `name`, `rootHash`.        |
| GET    | `/api/events`       | SSE event stream (see below).              |

#### Write Endpoints

All write endpoints use an **async 202 pattern**: the server acquires a lock, returns `202 Accepted` with a message ID immediately, then processes the message in the background. When processing completes, a `message:processed` or `message:failed` event is emitted via the event stream.

| Method | Path                   | Body                              | Description                      |
|--------|------------------------|-----------------------------------|----------------------------------|
| POST   | `/api/messages`        | `{ type, name?, payload?, ... }`  | Send any message type.           |
| POST   | `/api/actions/:name`   | `{ ...payload }`                  | Shorthand for action messages.   |
| POST   | `/api/blackboard/:key` | `{ value }`                       | Shorthand for write messages.    |

#### Control Endpoints

These endpoints bypass the processing lock and take effect immediately.

| Method | Path              | Description                                                                                         |
|--------|-------------------|-----------------------------------------------------------------------------------------------------|
| POST   | `/api/interrupt`  | Interrupts the active processing loop. Returns `{ interrupted: true, messageId }` or `{ interrupted: false }`. |
| POST   | `/api/resume`     | Clears the held state. Returns `{ resumed: true }` or `{ resumed: false }`.                        |

#### Error Responses

| Status | Meaning                                        |
|--------|------------------------------------------------|
| 400    | Invalid request (missing `type`, etc.).        |
| 404    | Unknown route.                                 |
| 409    | Another message is currently being processed.  |
| 500    | Internal server error.                         |

### Locking

Only one message is processed at a time per session. The server acquires an exclusive lock before processing and releases it on completion. If a second request arrives while processing is in progress, it receives a `409 Conflict` response.

For long-running agent calls, the lock is renewed every 10 seconds via a heartbeat to prevent expiration.

### SSE Event Stream

`GET /api/events` opens a Server-Sent Events stream. On connection, the server sends:

1. A `snapshot` event with the current blackboard, tree root hash, and last message timestamp.
2. Incremental events as they occur during processing.

The stream supports the `Last-Event-ID` header for automatic reconnection and replay.

```typescript
// Browser
const source = new EventSource('http://localhost:3148/api/events');
source.addEventListener('snapshot', (e) => {
  const state = JSON.parse(e.data);
  console.log('Initial state:', state.blackboard);
});
source.addEventListener('message:processed', (e) => {
  const { messageId, treeStatus } = JSON.parse(e.data);
  console.log(`Message ${messageId} completed: ${treeStatus}`);
});
source.addEventListener('message:interrupted', (e) => {
  const { messageId } = JSON.parse(e.data);
  console.log(`Message ${messageId} was interrupted`);
});
```

---

## StateStore

The `StateStore` interface abstracts state persistence, locking, and event streaming. Two implementations are included.

### InMemoryStateStore

For local development and testing. State lives in process memory and is lost on restart.

```typescript
import { InMemoryStateStore } from 'cartographer';

const store = new InMemoryStateStore({ maxEvents: 1000 });
```

### RedisStateStore

For production deployments. Uses Redis for durable state, `SET NX EX` with Lua scripts for safe locking, and Redis Streams for event delivery.

```typescript
import Redis from 'ioredis';
import { RedisStateStore } from 'cartographer';

const store = new RedisStateStore({
  redis: new Redis(process.env.REDIS_URL),
  keyPrefix: 'myapp:',
  maxEvents: 5000,
});

const server = new ActorServer({
  createTree: () => myTreeFactory(),
  stateStore: store,
});
```

`RedisStateStore` requires `ioredis` as a peer dependency.

### Custom Implementations

Implement the `StateStore` interface to use any backing store:

```typescript
interface StateStore {
  // State
  getState(key: string): Promise<TreeSessionState | null>;
  saveState(key: string, state: TreeSessionState): Promise<void>;
  deleteState(key: string): Promise<void>;
  listKeys(): Promise<string[]>;

  // Locking
  acquireLock(key: string, requestId: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string, requestId: string): Promise<void>;

  // Events
  appendEvents(key: string, events: TreeEvent[]): Promise<void>;
  readEvents(key: string, lastEventId?: string): AsyncIterable<TreeEvent>;
}
```

---

## Client SDK

`createCartographerClient` creates a lightweight client for browser and Node.js environments.

```typescript
import { createCartographerClient } from 'cartographer';

const client = createCartographerClient('http://localhost:3148');
```

### Sending Messages

```typescript
// Send an action (fire-and-forget)
const { id } = await client.action('approve', { comment: 'LGTM' });

// Write to the blackboard
await client.write('config:theme', 'dark');

// Send any message type
await client.send({ type: 'tick' });

// Send an action and wait for processing to complete (requires SSE connection)
client.connect();
const result = await client.actionAndWait('approve', { comment: 'LGTM' });
console.log(result.treeStatus); // 'success', 'failure', or 'running'
```

### Interrupting and Resuming

```typescript
// Interrupt the currently processing message (bypasses the lock)
const { interrupted } = await client.interrupt();

// Clear the held state so the next tick processes normally
const { resumed } = await client.resume();

// Interrupt, wait for lock release via SSE, then send a new action.
// Requires connect() since it listens for message:processed/message:failed events.
// If nothing was processing, the action is sent immediately without SSE.
client.connect();
const { id } = await client.interruptAndAction('redirect', { target: 'new-path' });
```

### Reading State

```typescript
const bb = await client.blackboard();   // Current blackboard
const tree = await client.tree();       // Tree structure
const status = await client.status();   // Tree metadata
```

### Real-Time Events

The client uses the browser `EventSource` API for SSE. In Node.js, you need a polyfill like the `eventsource` package or the `--experimental-eventsource` flag (Node 22+). If `globalThis.EventSource` is undefined, `connect()` silently returns without error — `actionAndWait()` and `interruptAndAction()` (when processing is active) will hang indefinitely in this case since they depend on SSE events dispatched by the connection.

```typescript
// Start listening for events
client.connect();

// Listen for specific events
client.on('message:processed', (data) => {
  console.log('Processing complete:', data);
});

// Listen for client events emitted by emitToClient nodes
client.on('ui:show_review', (data) => {
  renderReviewPanel(data);
});

// Listen for all events
client.onAny((event, data) => {
  console.log(event, data);
});

// Stop listening
client.disconnect();
```

### Error Handling

When the server returns `409 Conflict` (another message is being processed), the client throws a `ConflictError`:

```typescript
import { ConflictError } from 'cartographer';

try {
  await client.action('approve');
} catch (err) {
  if (err instanceof ConflictError) {
    console.log('Server is busy, try again later');
  }
}
```

---

## Application Nodes

The application server introduces three specialized nodes designed for message-driven trees.

### actionReceived

Checks and consumes an action from the blackboard. Returns `SUCCESS` if the action is present (and removes it), `FAILURE` otherwise.

```typescript
import { actionReceived } from 'cartographer';

const node = actionReceived('approve');
// Checks blackboard for 'actions:approve', consumes it on success
```

`actionReceived` is non-reactive and synchronous — it extends `BaseNode` directly, not `ActionNode` or `ConditionNode`. This ensures sequences cache its `SUCCESS` in the `completedMap`, preventing the consumed key from being re-read.

The optional `mapPayload` callback extracts data from the action payload:

```typescript
const node = actionReceived('approve', {
  mapPayload: (payload, blackboard) => {
    blackboard.set('review:decision', (payload as any).decision);
  },
});
```

### emitToClient

Sends structured data to the client via a dual write:

1. Writes to `clientEvents:<name>` on the blackboard (durable record, survives serialization).
2. Emits a `client:event` event (real-time delivery via SSE).

```typescript
import { emitToClient } from 'cartographer';

const node = emitToClient('ui:show_review', (ctx) => ({
  findings: ctx.blackboard.get('analysis'),
  timestamp: Date.now(),
}));
```

Clients can listen for these events by name:

```typescript
client.on('ui:show_review', (data) => {
  // data === { findings: ..., timestamp: ... }
});
```

### untilSuccess

A decorator that creates explicit suspension points. Converts child `FAILURE` to `RUNNING`, causing the tree to suspend until the next message arrives.

```typescript
import { untilSuccess, actionReceived, SelectorNode } from 'cartographer';

// Suspend until the user sends an 'approve' or 'reject' action
const waitForDecision = untilSuccess(
  new SelectorNode({
    name: 'decision',
    children: [
      actionReceived('approve'),
      actionReceived('reject'),
    ],
  }),
);
```

This is distinct from `RepeatNode` with `untilStatus: NodeStatus.SUCCESS`. `RepeatNode` loops *internally* within a single tick and never returns `RUNNING` due to child failure. `untilSuccess` returns `RUNNING` to the caller, allowing `runToCompletion()` to detect the suspension and save state.

---

## Serialization and Content Hashing

The application server serializes and restores tree execution state across messages. This is transparent — you do not need to manage it unless you are building custom integrations.

### Content Hashing

Every node computes a deterministic content hash based on its type, name, configuration, and children's hashes (Merkle-style). The root node's hash (`tree.rootHash`) serves as a fingerprint of the entire tree topology.

The hash is used for:
- **Node identity** in the serialized state map (no developer-assigned IDs needed).
- **Topology versioning** — if the tree factory produces a different shape, the root hash changes and the framework detects the mismatch.

### Topology Policy

When persisted state has a different `rootHash` than the current tree factory:

- `'fail'` (default): throws an error. Use when tree shape changes are bugs.
- `'reset'`: silently discards the old state and starts fresh. Use during development or when tree evolution is expected.

---

## Where to go next

- [Nodes](guide-nodes.md) -- leaf node reference including ActionNode and AgentNode.
- [Decorators](guide-decorators.md) -- all decorator nodes including untilSuccess.
- [Blackboard and Events](guide-blackboard-and-events.md) -- state management and event system.
- [Error Handling](guide-error-handling.md) -- abort and recovery patterns.
