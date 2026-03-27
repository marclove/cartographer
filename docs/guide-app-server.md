# Application Server

The application server turns Cartographer's behavior trees into persistent, message-driven services. Instead of ticking a tree in a loop, you define a tree factory and let the server handle state persistence, HTTP endpoints, and client communication.

This guide covers the full stack: `MessageProcessor` for processing, `ActorServer` for HTTP, `StateStore` for persistence, and the client SDK for browser/Node.js consumers.

---

## Overview

A Cartographer tree lives in memory and runs until its process ends. The application server changes this:

1. A **tree factory** creates a fresh tree for every incoming message.
2. **MessageProcessor** loads persisted state, hydrates the tree, processes one message to completion, then serializes and saves the result.
3. **ActorServer** wraps MessageProcessor with an HTTP server — REST endpoints for sending messages, SSE for real-time events, and read endpoints for inspecting state.
4. A **Client SDK** connects frontends to the server via fetch and EventSource.

The tree itself is _transient_ — created per request, then discarded. The _state_ is durable, stored in a `StateStore` (in-memory for development, Redis for production).

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
  receive,
  untilSuccess,
  notify,
} from "cartographer";

const server = new ActorServer({
  createTree: () =>
    new BehaviorTree({
      name: "review-flow",
      root: new SequenceNode({
        name: "main",
        children: [
          // Agent analyzes the document
          new ActionNode({
            name: "analyze",
            action: async (ctx) => {
              ctx.blackboard.set("analysis", { summary: "Looks good" });
              return NodeStatus.SUCCESS;
            },
          }),
          // Send findings to the client
          notify("ui:show_review", (ctx) => ({
            findings: ctx.blackboard.get("analysis"),
          })),
          // Wait for user approval or rejection
          untilSuccess(
            new SelectorNode({
              name: "wait-for-decision",
              children: [receive("approve"), receive("reject")],
            }),
          ),
        ],
      }),
    }),
  sessionId: "default",
  port: 3148,
});

await server.start();
console.log("ActorServer running on http://localhost:3148");
```

Then from a browser or Node.js client:

```typescript
import { createCartographerClient } from "cartographer";

const client = createCartographerClient("http://localhost:3148");

// Start the tree
await client.send({ type: "tick" });

// Read blackboard state
const bb = await client.blackboard();
console.log(bb.analysis); // { summary: 'Looks good' }

// Send a user command
await client.command("approve", { comment: "Ship it" });
```

---

## MessageProcessor

`MessageProcessor` is the per-message processor. It is transient — created for each request, processes exactly one message, then discarded. You typically do not use it directly; `ActorServer` manages it internally.

### Processing Pipeline

For each message, `MessageProcessor.process()` runs this pipeline:

1. **Create tree** from the factory function.
2. **Load state** from the `StateStore` (blackboard values, serialized tree execution state, and named session registry).
3. **Restore** the tree's execution state and session registry using content-hash-based serialization.
4. **Apply the message** — write command payloads or blackboard values.
5. **Run to completion** — tick the tree repeatedly until it reaches a terminal status (`SUCCESS`/`FAILURE`) or suspends (`RUNNING` with no in-flight work).
6. **Serialize** tree state, blackboard, and session registry.
7. **Save** back to the `StateStore`.

Session registry persistence means agents configured with [named sessions](guide-agent-integration.md#sessions) can resume conversations across server restarts — the session IDs are serialized in `TreeSessionState.sessions` and restored into the tree's `SessionRegistry` on the next message.

### Run to Completion

The `runToCompletion()` loop is the core of the processing model. It distinguishes between two kinds of `RUNNING`:

- **In-flight work** (`hasInflightWork() === true`): An `ActionNode` or `AgentNode` has an async operation in progress. The loop waits for it to settle via `settled()`, then ticks again.
- **Suspended** (`hasInflightWork() === false`): The tree returned `RUNNING` but nothing is in progress — typically because an `untilSuccess` or `receive` node is waiting for external input. The loop exits.

```typescript
const processor = new MessageProcessor({
  createTree: () => myTreeFactory(),
  stateStore: myStore,
  stateKey: "session-123",
});

const result = await processor.process({ type: "tick" });
// result.treeStatus is 'success', 'failure', 'running' (suspended), or 'error' (signal handled)
```

### Message Types

| Type      | Fields                                       | Effect                                                                                                                                                                                                                                                                                  |
| --------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tick`    | —                                            | Ticks the tree with no additional input.                                                                                                                                                                                                                                                |
| `command` | `name`, `payload?`                           | Writes `payload` to `commands:<name>` on the blackboard, then ticks.                                                                                                                                                                                                                    |
| `write`   | `key`, `value`                               | Writes `value` to `key` on the blackboard, then ticks.                                                                                                                                                                                                                                  |
| `signal`  | `signal: 'stop'\|'reset'\|'abort'\|'resume'` | Resets or aborts the tree without ticking. `reset` calls `tree.reset()`, `abort` calls `tree.abort()`. `resume` clears the held state (see [Interrupts](#interrupts) below). `stop` is accepted but is currently a no-op. All signals return `{ treeStatus: 'error' }` without ticking. |

### Interrupts

When a long-running `AgentNode` is processing (seconds to minutes), the user may want to cancel the current work without losing progress. `interrupt` is a middle ground between doing nothing and a full `abort`:

| Operation      | Cancels in-flight work | Clears completedMap | Requires reset() | Tree afterward     |
| -------------- | ---------------------- | ------------------- | ---------------- | ------------------ |
| **abort**      | Yes                    | Yes                 | Yes              | Dead (needs reset) |
| **interrupt**  | Yes                    | No                  | No               | RUNNING, suspended |
| **do nothing** | No                     | No                  | No               | RUNNING, in-flight |

After interrupt, the tree is in the same state as a normal suspension point: `RUNNING` with `hasInflightWork() === false`. Sequence `completedMap` entries survive, so previously completed children are not re-executed.

#### How it works

`MessageProcessor` holds an internal `interruptController`. The `runToCompletion()` loop races `tree.settled()` against this interrupt signal. When interrupted:

1. `tree.interrupt()` is called — cancels in-flight SDK calls while preserving composite cycle state.
2. The tree is serialized and saved normally.
3. The state is marked as **held** (`held: true` in `TreeSessionState`).
4. The `ProcessResult` includes `{ interrupted: true, treeStatus: 'running' }`.

#### Held state

After interrupt, the tree enters a **held** state. This prevents the scheduler from immediately restarting the interrupted agent before the user has a chance to redirect.

While held:

- **`tick` messages** → no-op (returns `{ treeStatus: 'running', held: true }` without processing).
- **`command` / `write` messages** → clear held flag, then process normally.
- **`signal: resume`** → clear held flag without ticking (next scheduler tick resumes the agent).

#### What happens after interrupt

The interrupted agent's in-flight state is cleared. On the next deliberate user action:

- **"Cancel and move on"**: send an action that takes a different path (clears held, processes action).
- **"Cancel and redirect"**: send a `write` to update blackboard context (clears held, processes write, re-invokes agent on next tick).
- **"Just retry as-is"**: `POST /api/resume` (clears held), then the next scheduler tick resumes the agent.

```typescript
const processor = new MessageProcessor({
  createTree: () => myTreeFactory(),
  stateStore: myStore,
  stateKey: "session-123",
});

// Start processing in the background
const processPromise = processor.process({ type: "tick" });

// Interrupt from another context (e.g., HTTP handler)
processor.requestInterrupt();

const result = await processPromise;
// result.treeStatus === 'running'
// result.interrupted === true
```

---

## ActorServer

`ActorServer` wraps `MessageProcessor` with an HTTP server. It handles routing, JSON parsing, locking, and SSE event delivery.

### Configuration

```typescript
const server = new ActorServer({
  createTree: () => myTreeFactory(), // Required: tree factory
  sessionId: "default", // Required: static key or resolver function
  stateStore: new InMemoryStateStore(), // Optional (default: InMemoryStateStore)
  port: 3148, // Optional (default: PORT env var or 3148)
  context: { tenantId: "abc" }, // Optional: written to blackboard as context:*
  topologyPolicy: "fail", // Optional: 'fail' or 'reset' on tree shape change
  maxQueueDepth: 16, // Optional: max queued messages (default: CARTOGRAPHER_MAX_QUEUE_DEPTH env or 16)
  autoTick: { intervalMs: 5000 }, // Optional: auto-tick interval
});

const { port } = await server.start();
console.log(`Listening on port ${port}`);

// Graceful shutdown
await server.stop();
```

The `context` option injects key-value pairs into the blackboard, prefixed with `context:`. Context is applied lazily when a session processes its first message. Use it to pass deployment metadata like tenant IDs or user preferences.

### Endpoints

#### Read Endpoints

| Method | Path                | Description                                                          |
| ------ | ------------------- | -------------------------------------------------------------------- |
| GET    | `/_platform/health` | Platform health check. Returns `{ status: "ok", uptime }`.           |
| GET    | `/api/status`       | Tree metadata: name, tick/cycle counts, last status, uptime.         |
| GET    | `/api/tree`         | Tree structure: `name`, serialized root.                             |
| GET    | `/api/blackboard`   | Current blackboard state as JSON.                                    |
| GET    | `/api/nodes/:id`    | Individual node detail. Includes agent metadata for `AgentNode`s.    |
| GET    | `/events`           | SSE event stream (see below).                                        |

#### Write Endpoints

All write endpoints use an **async 202 pattern**: the server acquires a lock, returns `202 Accepted` with a message ID immediately, then processes the message in the background. When processing completes, a `message:processed` or `message:failed` event is emitted via the event stream.

If the server is already processing a message, incoming messages are placed in a bounded queue and return `202 Accepted` with `status: 'queued'` and a `position`. Queued messages are processed in FIFO order after the current message completes. See [Message Queue](#message-queue) below.

| Method | Path                   | Body                             | Description                     |
| ------ | ---------------------- | -------------------------------- | ------------------------------- |
| POST   | `/api/messages`        | `{ type, name?, payload?, ... }` | Send any message type.          |
| POST   | `/api/commands/:name`  | `{ ...payload }`                 | Shorthand for command messages. |
| POST   | `/api/blackboard/:key` | `{ value }`                      | Shorthand for write messages.   |

#### Control Endpoints

These endpoints bypass the processing lock and take effect immediately.

| Method | Path             | Description                                                                                                    |
| ------ | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/interrupt` | Interrupts the active processing loop. Returns `{ interrupted: true, messageId }` or `{ interrupted: false }`. |
| POST   | `/api/resume`    | Clears the held state. Returns `{ resumed: true }` or `{ resumed: false }`.                                    |

#### Error Responses

| Status | Meaning                                                    |
| ------ | ---------------------------------------------------------- |
| 400    | Invalid request (missing `type`, etc.).                    |
| 404    | Unknown route.                                             |
| 429    | Message queue is full (server is busy and queue overflow). |
| 500    | Internal server error.                                     |

### Locking

Only one message is processed at a time per session. The server acquires an exclusive lock before processing and releases it on completion. For long-running agent calls, the lock is renewed every 10 seconds via a heartbeat to prevent expiration.

### Message Queue

When a message arrives while the server is processing, it is placed in a bounded, persistent queue rather than being rejected. The server returns `202 Accepted` with `status: 'queued'` and a `position` indicating where the message sits in the queue (1-based).

Queued messages are processed in FIFO order. After each message completes, the server drains the next message from the queue automatically. The queue is persisted in the `StateStore`, so messages survive server restarts.

The queue depth is controlled by `maxQueueDepth` (default: `CARTOGRAPHER_MAX_QUEUE_DEPTH` env var, or `16`). When the queue is full, the server returns `429` and the client throws a `QueueFullError`.

The full message lifecycle is observable via SSE events:

1. `message:queued` — message was enqueued (includes `position`)
2. `message:dequeued` — queued message is now being processed
3. `message:processed` / `message:failed` / `message:interrupted` — processing completed

### SSE Event Stream

`GET /events` opens a Server-Sent Events stream. On connection, the server sends:

1. A `snapshot` event with the current blackboard, tree root hash, and last message timestamp.
2. Incremental events as they occur during processing.

The stream supports the `Last-Event-ID` header for automatic reconnection and replay.

```typescript
// Browser
const source = new EventSource("http://localhost:3148/events");
source.addEventListener("snapshot", (e) => {
  const state = JSON.parse(e.data);
  console.log("Initial state:", state.blackboard);
});
source.addEventListener("message:queued", (e) => {
  const { messageId, position } = JSON.parse(e.data);
  console.log(`Message ${messageId} queued at position ${position}`);
});
source.addEventListener("message:dequeued", (e) => {
  const { messageId } = JSON.parse(e.data);
  console.log(`Message ${messageId} is now processing`);
});
source.addEventListener("message:processed", (e) => {
  const { messageId, treeStatus } = JSON.parse(e.data);
  console.log(`Message ${messageId} completed: ${treeStatus}`);
});
source.addEventListener("message:interrupted", (e) => {
  const { messageId } = JSON.parse(e.data);
  console.log(`Message ${messageId} was interrupted`);
});
```

### Session Resolution

The `sessionId` option (required) determines which session key is used for each request. It accepts either a static string or a resolver function.

For a single-user application, pass a static string:

```typescript
const server = new ActorServer({
  createTree: () => myTreeFactory(),
  sessionId: "default",
});
```

For per-user sessions, pass a resolver function that extracts the session key from the Hono request context. Cartographer is auth-agnostic — it provides the integration surface for connecting session identity to your existing auth system.

```typescript
const server = new ActorServer({
  createTree: () => myTreeFactory(),
  stateStore: new RedisStateStore({ redis }),
  sessionId: async (c) => {
    const session = c.get("session");
    if (!session?.userId) return ""; // returning falsy triggers a 401
    return `user:${session.userId}`;
  },
});
```

The resolver runs as middleware on every request (except health and tree-structure endpoints, which are session-independent). It can be synchronous or async. Returning a falsy value results in a `401 Unauthorized` response.

The same tree factory is used for all sessions (uniform topology). Per-user customization is handled through the `context` option, which writes key-value pairs as `context:{key}` on the blackboard when a session processes its first message:

```typescript
const server = new ActorServer({
  createTree: () => myTreeFactory(),
  stateStore: new RedisStateStore({ redis }),
  sessionId: async (c) => c.get("session")?.userId,
  context: { plan: "enterprise" },
});
// Each session's blackboard starts with context:plan = 'enterprise'
// The tree can read it: ctx.blackboard.get('context:plan')
```

When `autoTick` is configured, it ticks the static session key (or `'default'` when `sessionId` is a resolver). Other sessions are request-driven — use external triggers like webhooks or cron jobs for background ticking of specific sessions.

#### Stream Eviction

The server maintains an in-memory event replay buffer per session for SSE reconnection support. The `streamEvictionMs` option controls how long an idle session's buffer is kept in memory after the last SSE client disconnects. Defaults to 5 minutes (`300_000`ms). Set to `0` to disable eviction entirely.

```typescript
const server = new ActorServer({
  createTree: () => myTreeFactory(),
  stateStore: new RedisStateStore({ redis }),
  sessionId: async (c) => c.get("session")?.userId,
  streamEvictionMs: 600_000, // 10 minutes
});
```

Activity resets the eviction timer — if a new SSE client connects or a message is processed for the session before the timer fires, the buffer is preserved. Eviction only removes the in-memory replay buffer; persisted state in the `StateStore` is unaffected.

---

## Hono App Factory

`ActorServer` is a thin wrapper around a composable Hono app factory. If you need to mount a Cartographer API into an existing Hono server or apply custom middleware, use the factory directly.

### createApp

Returns an `AppHandle` with the full actor Hono app, message processing, and queue management.

```typescript
import { createApp } from "cartographer";
import { Hono } from "hono";

const handle = createApp({
  createTree: () => myTreeFactory(),
  sessionId: "default",
  stateStore: myStore,
});

// Mount into a larger Hono server
const root = new Hono();
root.route("/cartographer", handle.app);

// Initialize and start processing
await handle.start();
```

`handle.start()` initializes the server and drains queued messages for all known sessions. For fine-grained control, `drainQueue(sessionKey)` accepts the session key to drain.

### Mounting into Express or Fastify

`handle.nodeHandler()` returns a standard Node HTTP request listener that works with Express, Fastify, or any framework that accepts `(req, res) => void` handlers. `handle.start()` and `handle.stop()` compose the lifecycle calls so you don't have to manage them individually.

**Express:**

```typescript
import express from "express";
import { createApp } from "cartographer";

const handle = createApp({
  createTree: () => myTreeFactory(),
  sessionId: "default",
  stateStore: myStore,
  autoTick: { intervalMs: 5000 },
});

const app = express();
app.use("/cartographer", handle.nodeHandler());

await handle.start();
const server = app.listen(3000, () => {
  handle.startAutoTick();
});

process.on("SIGTERM", () => {
  handle.stop();
  server.close();
});
```

**Fastify** (requires `@fastify/middie` for Express-style middleware support):

```typescript
import Fastify from "fastify";
import middie from "@fastify/middie";
import { createApp } from "cartographer";

const handle = createApp({
  createTree: () => myTreeFactory(),
  sessionId: "default",
  stateStore: myStore,
});

const fastify = Fastify();
await fastify.register(middie);
fastify.use("/cartographer", handle.nodeHandler());

await handle.start();
await fastify.listen({ port: 3000 });
handle.startAutoTick();

fastify.addHook("onClose", () => {
  handle.stop();
});
```

**SSE streaming note:** The `/events` endpoint uses Server-Sent Events via `ReadableStream`. Response compression middleware (Express `compression()`, Fastify `@fastify/compress`) will buffer the stream and prevent real-time delivery. Either exclude the Cartographer mount path from compression or filter out `text/event-stream` responses. The same applies to reverse proxies — set `proxy_buffering off` for the events path.

`start()` calls `initializeState()` and `drainQueue()`. `startAutoTick()` is called separately after the server is listening. `stop()` calls `stopAutoTick()` and `closeSseClients()`. The individual methods remain available on `AppHandle` for fine-grained control.

---

## StateStore

The `StateStore` interface abstracts state persistence, locking, and event streaming. Two implementations are included.

### InMemoryStateStore

For local development and testing. State lives in process memory and is lost on restart.

```typescript
import { InMemoryStateStore } from "cartographer";

const store = new InMemoryStateStore({ maxEvents: 1000 });
```

### RedisStateStore

For production deployments. Uses Redis for durable state, `SET NX EX` with Lua scripts for safe locking, and Redis Streams for event delivery.

```typescript
import Redis from "ioredis";
import { RedisStateStore } from "cartographer";

const store = new RedisStateStore({
  redis: new Redis(process.env.REDIS_URL),
  keyPrefix: "myapp:",
  maxEvents: 5000,
});

const server = new ActorServer({
  createTree: () => myTreeFactory(),
  sessionId: "default",
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
import { createCartographerClient } from "cartographer";

const client = createCartographerClient("http://localhost:3148");
```

### Cross-Origin Credentials

When the client and server are on different origins (common when auth cookies need to be forwarded), pass the `credentials` option:

```typescript
const client = createCartographerClient("https://api.example.com", {
  credentials: "include", // Send cookies cross-origin
});
```

| Value | Behavior |
| --- | --- |
| `'same-origin'` | Send cookies only for same-origin requests (default) |
| `'include'` | Always send cookies, even cross-origin |
| `'omit'` | Never send cookies |

The `credentials` setting applies to all `fetch()` calls (POST and GET) and sets `withCredentials` on the `EventSource` SSE connection.

### Sending Messages

```typescript
// Send an action (fire-and-forget)
const { id } = await client.command("approve", { comment: "LGTM" });

// Write to the blackboard
await client.write("config:theme", "dark");

// Send any message type
await client.send({ type: "tick" });

// Send a command and wait for processing to complete (requires SSE connection)
client.connect();
const result = await client.commandAndWait("approve", { comment: "LGTM" });
console.log(result.treeStatus); // 'success', 'failure', or 'running'
```

### Interrupting and Resuming

```typescript
// Interrupt the currently processing message (bypasses the lock)
const { interrupted } = await client.interrupt();

// Clear the held state so the next tick processes normally
const { resumed } = await client.resume();

// Interrupt, wait for lock release via SSE, then send a new command.
// Requires connect() since it listens for message:processed/message:failed events.
// If nothing was processing, the command is sent immediately without SSE.
client.connect();
const { id } = await client.interruptAndCommand("redirect", { target: "new-path" });
```

### Reading State

```typescript
const bb = await client.blackboard(); // Current blackboard
const tree = await client.tree(); // Tree structure
const status = await client.status(); // Tree metadata
```

### Real-Time Events

The client uses the browser `EventSource` API for SSE. In Node.js, you need a polyfill like the `eventsource` package or the `--experimental-eventsource` flag (Node 22+). If `globalThis.EventSource` is undefined, `connect()` silently returns without error — `commandAndWait()` and `interruptAndCommand()` (when processing is active) will hang indefinitely in this case since they depend on SSE events dispatched by the connection.

```typescript
// Start listening for events
client.connect();

// Listen for specific events
client.on("message:processed", (data) => {
  console.log("Processing complete:", data);
});

// Listen for client events emitted by notify nodes
client.on("ui:show_review", (data) => {
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

When the server is busy, messages are automatically queued. The client only throws an error if the queue is full (`429`):

```typescript
import { QueueFullError } from "@cartographer/client";

try {
  const response = await client.command("approve");
  if (response.status === "queued") {
    console.log(`Queued at position ${response.position}`);
  }
} catch (err) {
  if (err instanceof QueueFullError) {
    console.log("Server queue is full, try again later");
  }
}
```

---

## Application Nodes

The application server introduces three specialized nodes designed for message-driven trees.

### receive

Receives and consumes an inbound command from the blackboard. Returns `SUCCESS` if the command is present (and removes it), `FAILURE` otherwise.

```typescript
import { receive } from "cartographer";

const node = receive("approve");
// Checks blackboard for 'commands:approve', consumes it on success
```

`receive` is non-reactive and synchronous — it extends `BaseNode` directly, not `ActionNode` or `ConditionNode`. This ensures sequences cache its `SUCCESS` in the `completedMap`, preventing the consumed key from being re-read.

The optional `mapPayload` callback extracts data from the command payload:

```typescript
const node = receive("approve", {
  mapPayload: (payload, blackboard) => {
    blackboard.set("review:decision", (payload as any).decision);
  },
});
```

### notify

Sends structured data to the client via a dual write:

1. Writes to `clientEvents:<name>` on the blackboard (durable record, survives serialization).
2. Emits a `client:event` event (real-time delivery via SSE).

```typescript
import { notify } from "cartographer";

const node = notify("ui:show_review", (ctx) => ({
  findings: ctx.blackboard.get("analysis"),
  timestamp: Date.now(),
}));
```

Clients can listen for these events by name:

```typescript
client.on("ui:show_review", (data) => {
  // data === { findings: ..., timestamp: ... }
});
```

### untilSuccess

A decorator that creates explicit suspension points. Converts child `FAILURE` to `RUNNING`, causing the tree to suspend until the next message arrives.

```typescript
import { untilSuccess, receive, SelectorNode } from "cartographer";

// Suspend until the user sends an 'approve' or 'reject' action
const waitForDecision = untilSuccess(
  new SelectorNode({
    name: "decision",
    children: [receive("approve"), receive("reject")],
  }),
);
```

This is distinct from `Repeat` with `untilStatus: NodeStatus.SUCCESS`. `Repeat` loops _internally_ within a single tick and never returns `RUNNING` due to child failure. `untilSuccess` returns `RUNNING` to the caller, allowing `runToCompletion()` to detect the suspension and save state.

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
