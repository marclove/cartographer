# Agent-Enabled Application Framework — Design Spec

## Context

Cartographer's blackboard + event system already functions as a reactive state layer. The dashboard proves this: blackboard writes flow via SSE to Svelte runes, events provide a complete audit trail, and scoped namespaces partition state cleanly. The missing piece is *bidirectional communication* — the UI can observe state but can't write back. This design turns Cartographer from a behavior tree library into a general-purpose application framework where AI agents and human users collaborate through shared state and structured messages.

## Design Summary

The design is structured in two phases that share the same architecture. Phase 1 delivers a usable framework and exercises all the hard machinery (processing loop, serialization, state persistence, in-flight detection, suspension). Phase 2 adds multi-user sessions as a routing layer on top — not an architectural change.

**Phase 1 — Single-Tree ActorServer.** One tree, one blackboard, root-level endpoints. Full processing loop with serialization and state persistence on every message, even for the single tree. This derisks the hard parts (content hashing, `completedMap` round-trip, in-flight detection, suspension) in isolation.

**Phase 2 — Sessions.** Explicit, isolated sessions with per-session trees. Tree factory, session lifecycle endpoints, session-scoped endpoints alongside the Phase 1 root-level endpoints (which become shortcuts for a default session, preserving backward compatibility). Dashboard rework.

---

# Phase 1: Core Framework

## 1. Processing Loop

### Tick Loop

The actor ticks the tree until it reaches a terminal state (SUCCESS/FAILURE) or is *suspended* — RUNNING with no in-flight work, meaning it's waiting for external input.

Two additions to the node interface support this. Each node in the BTreeNode interface gains:
- `hasInflightWork(): boolean` — returns true if this node has unsettled in-flight work: `_inflightState` is non-null *and* neither `result` nor `error` has been populated yet. A node whose promise has resolved but hasn't been collected by a subsequent tick is *not* considered in-flight — it's waiting for a tick, not for external work. Composites/decorators delegate to their children.
- `inflightPromise(): Promise<void> | null` — returns the in-flight promise if the node has unsettled work (same check as `hasInflightWork`), null otherwise. Composites/decorators aggregate children.

Note: `_inflightState` is currently `private` on `ActionNode` and `AgentNode`. These methods require either making the field `protected` or adding an accessor on the base class. The implementation should add an `_inflightState` field to `BaseNode` (defaulting to null) with the `hasInflightWork()` and `inflightPromise()` implementations, so leaf nodes that don't use in-flight work inherit the no-op behavior.

BehaviorTree exposes these as tree-level methods:
- `hasInflightWork()` — delegates to the root node's recursive check
- `settled()` — collects all `inflightPromise()` values from the tree and returns `Promise.all()`. Resolves when all in-flight work has completed. `Promise.all()` is used rather than `Promise.allSettled()` because individual nodes already handle their own errors internally (catching exceptions and storing them on `_inflightState.error`). An unhandled rejection here indicates a bug that should surface, not be silently absorbed.

```
process(msg):
  if msg.type == 'action':
    blackboard.set(`actions:${msg.name}`, msg.payload)
    emit('actor:message:received', msg)
    runToCompletion()
  if msg.type == 'write':
    blackboard.set(msg.key, msg.value)
    runToCompletion()
  if msg.type == 'tick':
    runToCompletion()
  if msg.type == 'signal':
    handleSignal(msg)

runToCompletion():
  loop:
    status = await tree.tick()
    if status != RUNNING: break           // terminal — cycle complete
    if not tree.hasInflightWork(): break   // suspended — waiting for input
    await tree.settled()                   // wait for in-flight work, then tick to collect results
```

The TreeActor is transient — created per request, processes one message, then discarded. Each HTTP request to a write endpoint triggers one `process(msg)` call within the state lifecycle. This preserves the existing polling model (AgentNode kicks off SDK calls in the background, returns RUNNING, polls on subsequent ticks) while ensuring the tree reaches a clean resting state before serialization.

### Message Types

| Type | Purpose | Triggers tick? |
|------|---------|----------------|
| `tick` | Scheduled or manual tick | Yes |
| `action` | Named user action with payload | Yes (writes payload to blackboard first) |
| `write` | Direct blackboard key/value update | Yes |
| `signal` | Control: stop, reset, abort | No (handled by actor) |

### Guarantees

- **Sequential processing** — one message fully processed (tree reaches terminal state or suspension) before the next begins. Concurrent requests are serialized by a lock (see below).
- **No concurrent blackboard mutation** — only one message is processing at a time
- **Backpressure** — concurrent HTTP requests receive 409 Conflict while a lock is held

### Locking

The critical section spans the entire message lifecycle (load → process → save), which can take seconds or minutes when agent nodes make API calls. This rules out optimistic approaches like WATCH/MULTI — the window is too long and retries would be wasteful.

**`InMemoryStateStore`**: async mutex. Incoming requests while processing is active receive 409 Conflict immediately.

**`RedisStateStore`**: Redis SET-based lock with heartbeat renewal. On request:
1. `SET tree:lock <requestId> NX EX 30` — acquire a lock with a 30-second TTL.
2. If acquired: start a background heartbeat that renews the TTL every 10 seconds (`SET tree:lock <requestId> XX EX 30` — only renews if the requestId still matches).
3. If not acquired: return 409 Conflict to the client.
4. Processing runs for as long as the tree needs (seconds for simple trees, minutes or longer for agent tool loops). The heartbeat keeps the lock alive.
5. On completion: stop the heartbeat, release the lock with a Lua script that checks the `requestId` matches, preventing a request from releasing a lock it doesn't own.
6. If the processing machine crashes: the heartbeat stops, the TTL expires after at most 30 seconds, and the lock self-releases. The tree state in Redis is still consistent (it was never written, since the crash happened before save).

This is a single-instance Redis lock, not Redlock. For the typical single-Redis-instance deployment, it provides the correctness guarantee without distributed coordination complexity.

The `StateStore` interface exposes locking:

```ts
interface StateStore {
  // Locking
  acquireLock(key: string, requestId: string, ttlMs: number): Promise<boolean>
  releaseLock(key: string, requestId: string): Promise<void>
  // ...
}
```

### Async Processing Model

Write endpoints return immediately (202 Accepted). Processing runs asynchronously on the server:

1. **HTTP handler**: acquire lock (409 Conflict if held), return `{ id, status: "processing" }` to the client.
2. **Background task**: load tree state from KV, create tree from factory, restore execution state, apply message, run `runToCompletion()`.
3. **During processing**: events (blackboard writes, agent responses, `emitToClient`) flow to the client via SSE in real time. Lock heartbeat keeps the lock alive.
4. **On completion**: serialize tree state, save to KV, publish a `message:processed` event (with message ID and final tree status), release lock, discard tree.
5. **On error**: if the background task fails (factory throws, restore fails due to topology mismatch with "fail" policy, state deserialization error), publish a `message:failed` event, release the lock immediately, discard the tree. Tree state in the store is unchanged (save never happened).
6. **On crash**: heartbeat stops, lock TTL expires (max 30s), tree state is unchanged (save never happened). The client sees the SSE connection drop and can reconnect.

The `message:processed` event tells the client that processing is complete:
```json
{ "type": "message:processed", "messageId": "msg-1", "treeStatus": "running" }
```

The `message:failed` event tells the client that processing failed:
```json
{ "type": "message:failed", "messageId": "msg-1", "error": "Tree topology changed: stored rootHash abc123 does not match factory rootHash def456" }
```

The client SDK provides a convenience for callers who want to await completion:
```ts
// Fire-and-forget (observe via SSE events)
client.action('approve', { docId: '123' })

// Await completion (resolves when message:processed arrives on SSE)
const result = await client.actionAndWait('approve', { docId: '123' })
```

The SSE connection should be established before sending messages so the client doesn't miss events.

### Processing Model: In-Process vs. Job Queue

Processing runs as an in-process background task on the machine that accepted the HTTP request. This is a deliberate choice over a job queue (BullMQ, etc.) that dispatches work to separate worker processes.

**Why in-process for this design:**
- Simpler operations — one process type to deploy, no worker fleet to manage.
- Lower latency — processing starts immediately, no enqueue/dequeue hop.
- Fewer failure modes — no job serialization, retry policies, or dead letter queues.
- The lock, StateStore, and SSE infrastructure are the same regardless of where processing runs.

**The trade-off is message durability.** If the server crashes after returning 202 but before processing completes, the message is lost — the client received an acknowledgment but the work never finished. For user-initiated actions, recovery is straightforward: the SSE connection drops, the client reconnects and snapshots current state, and the user can resend. For automated triggers (scheduled ticks), there's no human to notice and retry.

**A job queue is the natural evolution** if message durability or independent worker scaling becomes a hard requirement. The migration is incremental: the HTTP handler enqueues to BullMQ (backed by the same Redis) instead of spawning a background task, and worker processes call the same `process(msg)` function with the same StateStore and lock semantics. No changes to the ActorServer API, client SDK, or SSE delivery.

### Suspension Points

The `untilSuccess()` decorator converts FAILURE to RUNNING, explicitly marking where the tree waits for external input. `actionReceived()` returns FAILURE when no action is present. Combined:

```ts
sequence([
    agent({ name: 'analyze', prompt: '...' }),
    emitToClient('ui:show_review', ...),
    untilSuccess(                              // suspension point
      selector([
        sequence([actionReceived('approve'), agent({ name: 'finalize', ... })]),
        sequence([actionReceived('reject'),  agent({ name: 'archive', ... })]),
      ])
    ),
    agent({ name: 'notify', prompt: '...' }),
])
```

When the selector fails (no action present), `untilSuccess` converts to RUNNING. No in-flight work exists, so `runToCompletion()` exits. When an action message later arrives, the actor writes it to the blackboard, the tree resumes at the `untilSuccess` node, `actionReceived` succeeds, and the cycle continues.

### Scheduler Integration

The existing TreeScheduler becomes a message source. Instead of directly calling `tree.tick()`, it sends `{ type: 'tick' }` messages through the ActorServer's write endpoints. Scheduled ticks, user actions, and external events all flow through the same processing pipeline.

---

## 2. State Management

### StateStore Interface

A `StateStore` interface abstracts the persistence layer, same pattern as the existing Blackboard interface:

```ts
interface StateStore {
  // Tree state
  getState(key: string): Promise<TreeSessionState | null>
  saveState(key: string, state: TreeSessionState): Promise<void>
  deleteState(key: string): Promise<void>
  listKeys(): Promise<string[]>

  // Locking
  acquireLock(key: string, requestId: string, ttlMs: number): Promise<boolean>
  releaseLock(key: string, requestId: string): Promise<void>

  // Event streaming (for SSE fan-out)
  appendEvents(key: string, events: TreeEvent[]): Promise<void>
  readEvents(key: string, lastEventId?: string): AsyncIterable<TreeEvent>  // blocks for new events, replays from lastEventId
}

interface TreeSessionState {
  blackboard: Record<string, unknown>
  treeState: SerializedTreeState             // root hash + per-node state keyed by content hash
  createdAt: number
  lastMessageAt: number
}
```

In Phase 1, the ActorServer stores its single tree under a fixed key (e.g., `"default"`). In Phase 2, each session gets its own key. The interface is the same — sessions are a naming layer.

Two implementations ship:
- `InMemoryStateStore` — for local dev, backed by a Map. Events delivered directly, in-memory buffer for replay on reconnect.
- `RedisStateStore` — for production (self-hosted or PaaS). Uses Redis for state persistence, Redis Streams for durable event delivery.

### Tree State Serialization

The tree is a content-addressed Merkle structure. Each node computes a hash from its own content and its children's hashes. This gives us stable node identity and automatic topology versioning with no developer-assigned IDs or version strings.

```ts
interface SerializedTreeState {
  rootHash: string                              // fingerprint of entire tree — serves as version
  nodes: { [contentHash: string]: NodeState }   // per-node execution state keyed by content hash
}
```

#### Content Hashing

Each node computes its hash bottom-up:

- **Leaf nodes**: `hash(type, name, serializable config)` — e.g., for AgentNode: type + name + model + prompt. Functions (action callbacks, condition predicates) are excluded since they aren't content-hashable, and changing an implementation doesn't change structural identity.
- **Decorators**: `hash(type, config, child_hash)`
- **Composites**: `hash(type, [child_0_hash, child_1_hash, ...])`

The hash is deterministic: same factory output → same hashes across invocations. No developer-assigned IDs needed.

The root hash is a fingerprint of the entire tree topology and configuration. Any change to any node — a modified prompt, an inserted child, a reordered sequence — propagates up to a different root hash.

#### Duplicate Node Handling

Two structurally identical nodes in the same tree produce the same hash. In practice this is rare — AgentNodes have unique names which are part of the hash, and most nodes differ in at least one config field. When a collision is detected during the tree walk (two nodes produce the same hash), a position disambiguator is appended (occurrence index in depth-first order, e.g., `abc123:0`, `abc123:1`). This keeps the common case clean and handles the edge case correctly.

#### Topology Versioning

On restore, the stored `rootHash` is compared against the factory tree's computed root hash. If they don't match, the tree has changed and the stored execution state is invalid. The ActorServer can be configured with a policy:

- **Fail** — reject the request with a clear error indicating the stored state is stale.
- **Reset** — discard the stored tree state and start fresh (blackboard state can optionally be preserved).

Migration between tree versions is not in scope for this design.

#### Serializable Execution State

Per node type:
- **Composites** (Sequence, Selector): `committedOrder` (resolved child evaluation order as content hashes), `completedMap` (content hash → terminal status for non-reactive children that have finished)
- **Composites** (Parallel): `completedMap` (content hash → terminal status for children that have finished within the current parallel cycle)
- **Decorators** (Retry, Repeat): current count
- **Leaf nodes** (ActionNode, AgentNode): last terminal status only

Note: the existing `completedMap` on all three composite types is `Map<BTreeNode, NodeStatus>` — keyed by live node reference. Similarly, `committedOrder` is `BTreeNode[] | null`. Serialization requires re-keying these structures by content hash. This is new implementation work on `SequenceNode`, `SelectorNode`, and `ParallelNode` — not a description of existing behavior.

#### Restore Process

1. `createTree()` produces a fresh tree from the factory.
2. The tree is walked bottom-up to compute content hashes and build a `hashToNode: Map<string, BTreeNode>` index (with disambiguators appended for any collisions).
3. The stored `rootHash` is compared against the computed root hash. Mismatch triggers the configured policy (fail or reset).
4. For each entry in `SerializedTreeState.nodes`, the corresponding live node is looked up by hash and `restore(state)` is called.
5. Composite `completedMap` entries are stored as `{ [contentHash]: status }`. During restore, hashes are resolved back to live `BTreeNode` references using the index from step 2.

Nodes gain `contentHash(): string`, `serialize(): NodeState`, and `restore(state: NodeState, hashToNode: Map<string, BTreeNode>)` methods.

#### In-Flight Work

`_inflightState` is never serialized. The `runToCompletion()` loop guarantees the tree is at rest (no in-flight operations) before serialization occurs.

### Blackboard Serialization

The blackboard is a flat key-value map, serialized as JSON alongside the tree state. On restore, the values are loaded into a fresh InMemoryBlackboard.

**Constraint:** all blackboard values must be JSON-serializable (strings, numbers, booleans, plain objects, arrays, null). Class instances, Dates, Buffers, functions, and other non-serializable values will be lost or corrupted during the serialize/restore cycle. This constraint should be enforced at the type level and documented for tree authors.

---

## 3. SSE Event Delivery

`GET /api/events` opens an SSE stream. Events emitted during processing (blackboard writes, `emitToClient` events, agent responses) are delivered to connected clients.

### Transport by StateStore

**`InMemoryStateStore`** (local dev): events are delivered directly — processing and SSE always happen on the same machine. An in-memory circular buffer (default capacity: 1000, matching the Redis Stream `MAXLEN ~1000`) provides replay on reconnect within the buffer window. If the client's `Last-Event-ID` predates the oldest buffered event, the server falls back to a fresh snapshot plus all buffered events. The existing `EventBuffer` from `src/server/event-buffer.ts` should be reused for this — it already implements circular buffering with `getEventsSince(lastId)` and capacity-based eviction.

**`RedisStateStore`** (production): uses Redis Streams (not pub/sub) for durable, replayable event delivery. The processing machine appends events to a Redis Stream (`XADD`). The machine holding the SSE connection reads from the stream (`XREAD BLOCK`). On reconnect, events since the client's last-seen ID are replayed. Redis Streams retain events until explicitly trimmed (configurable, e.g., `XTRIM MAXLEN ~1000`).

Redis pub/sub is not used because it is fire-and-forget — if the subscribing machine disconnects from Redis momentarily, events published during that gap are lost with no way to recover them.

### Snapshot on Reconnect

Regardless of transport, the SSE endpoint sends a full state snapshot on connect and reconnect (current blackboard, tree status, pending client events). This is the universal safety net: even if the event stream has gaps (network issues, buffer overflow, stream trimming), the client can always reconstruct current state from the snapshot.

The snapshot includes `processingMessageId: string | null` — the ID of the message currently being processed, or null if the tree is idle. This resolves a race condition: if a client connects (or reconnects) between the final state writes and the `message:processed` event, the snapshot reflects the final state but the client never sees the completion event. `processingMessageId` lets the client determine whether a message is still in flight without relying on having received every event.

### Durable Client Events

`emitToClient` writes its payload to the blackboard (under `clientEvents:<name>`) in addition to emitting an event. The event provides real-time reactivity; the blackboard entry is the durable record. This means a snapshot alone is sufficient for the client to rebuild its UI — the client doesn't depend on having received every event in order. When the client processes the event or reconnects and reads the snapshot, it clears the blackboard entry by sending a `write` message.

---

## 4. ActorServer (Phase 1)

The HTTP layer over the single tree. Replaces TreeServer. The existing read-endpoint handlers (`handleApiTree`, `handleApiStatus`, `handleApiBlackboard`, `handleApiNode` from `src/server/api-handlers.ts`), SSE handler (`handleSseStream` from `src/server/sse-handler.ts`), and event serializers (`src/server/serializers.ts`) should be reused rather than reimplemented.

### Configuration

```ts
const server = new ActorServer({
  createTree: () => buildMyTree(),
  stateStore: new RedisStateStore({ url: process.env.REDIS_URL }),
  context: {                         // written to blackboard under `context:` namespace on init
    tenantId: process.env.TENANT_ID,
    deploymentId: process.env.DEPLOYMENT_ID,
  },
})
```

When the ActorServer initializes, it calls `createTree()`, writes context values to the tree's blackboard (e.g., `context:tenantId`, `context:deploymentId`), and serializes the initial state. The `BehaviorTreeConfig` already accepts an optional `blackboard` parameter, so alternatively the ActorServer can construct a pre-populated blackboard and pass it to the factory. Either approach works — the requirement is that context values are present before the first tick.

For local dev, defaults keep things simple:

```ts
const server = new ActorServer({
  createTree: () => buildMyTree(),
  // stateStore defaults to InMemoryStateStore
})
```

### Platform Endpoint

- `GET /_platform/health` — liveness check, always returns `{ "status": "ok", "uptime": N }` with 200 while the process is alive. Independent of tree state. Required by the PaaS control plane (polled every 10s, 5s timeout, 30s grace period on startup).

### Read Endpoints

- `GET /api/tree` — serialized tree structure
- `GET /api/status` — tick count, last status
- `GET /api/blackboard` — current blackboard snapshot
- `GET /api/nodes/:nodeId` — node details
- `GET /api/events` — SSE stream (snapshot on connect, incremental events)

### Write Endpoints

- `POST /api/messages` — submit a message for processing
  ```json
  { "type": "action", "name": "approve", "payload": { "docId": "123" } }
  ```
  Returns immediately with `202 Accepted`:
  ```json
  { "id": "msg-1", "status": "processing" }
  ```
  The server acquires the lock and begins processing asynchronously. The client observes progress and completion via the SSE stream.

- `POST /api/actions/:name` — convenience for actions
  ```json
  { "docId": "123", "comment": "Looks good" }
  ```
  Equivalent to `POST /api/messages { type: "action", name: ":name", payload: body }`

- `POST /api/blackboard/:key` — convenience for writes
  ```json
  { "value": "approved" }
  ```

### Write Endpoint Error Responses

| Status | Condition |
|--------|-----------|
| `202 Accepted` | Lock acquired, processing started |
| `400 Bad Request` | Invalid message type, missing required fields (e.g., `action` with no `name`) |
| `409 Conflict` | Lock held — another message is being processed |
| `503 Service Unavailable` | Server is shutting down (post-SIGTERM) |

Errors that occur *after* 202 is returned (factory throws, restore fails, unhandled exception in processing) are reported via `message:failed` on the SSE stream — the HTTP response has already been sent.

### Transport

REST for sends + SSE for events. Pragmatic, works with existing dashboard architecture, easy to debug with curl. WebSocket can be added later for latency-sensitive use cases.

### Port

Defaults to `PORT` environment variable, falling back to 3148 for standalone/dev use. The PaaS sets `PORT=8080`.

### Graceful Shutdown

`ActorServer.start()` installs SIGTERM/SIGINT handlers. On signal: stop accepting new connections, wait for any in-progress message processing to complete, then close the HTTP server. The PaaS enforces a 30-second shutdown window.

### DashboardServer

Continues to reverse-proxy to the ActorServer. The Phase 1 dashboard gains write controls (send actions and blackboard writes via the new write endpoints), but the overall structure is unchanged — single tree, root-level endpoints.

---

## 5. Client SDK (Phase 1)

Lightweight client for connecting a frontend to a Cartographer tree.

```ts
const client = createCartographerClient('http://localhost:3148')

// Send messages
client.action('approve', { docId: '123' })
client.write('review:decision', 'approved')
client.send({ type: 'action', name: 'approve', payload: { docId: '123' } })

// Await completion
const result = await client.actionAndWait('approve', { docId: '123' })

// Read state (one-shot)
const state = await client.blackboard()
const tree = await client.tree()
const status = await client.status()

// Subscribe to events (wraps EventSource/SSE)
client.on('blackboard:write', ({ key, value }) => { ... })
client.on('agent:response', ({ node, result }) => { ... })
client.onAny((event, data) => { ... })

// Connection lifecycle
client.connect()     // opens SSE
client.disconnect()  // closes SSE
```

The client mirrors the TypedEventEmitter interface for subscriptions — same mental model on both sides. Framework-specific bindings (React hooks, Svelte stores) would be separate packages built on top.

### 409 Handling

When a send method (`action`, `write`, `send`) receives 409 Conflict, it rejects with a typed `ConflictError`. The client does not retry automatically — the caller decides whether to retry, queue, or discard. `actionAndWait` also rejects on 409 rather than silently retrying, since the caller explicitly awaits the result and should handle the contention.

### Error Events

`actionAndWait` resolves on `message:processed` and rejects on `message:failed`. The rejected error includes the message ID and the server-provided error string.

---

## 6. Tree Interaction Patterns

### actionReceived() — node factory

When the actor processes an action message, it writes the payload to `actions:<name>` on the blackboard, then ticks the tree. The `actionReceived()` factory returns a lightweight node that synchronously checks for this key.

`actionReceived` is its own node type extending BaseNode directly — not an ActionNode or ConditionNode. This matters for two reasons:
- **Non-reactive** — unlike ConditionNode, it won't be re-ticked within the same cycle. Sequences cache its SUCCESS in their `completedMap`. A reactive node would re-evaluate after consuming the key, find it gone, and return FAILURE, aborting the sequence.
- **Synchronous** — unlike ActionNode, it doesn't use the `_inflightState` polling model. A synchronous blackboard check doesn't need a background promise. It returns SUCCESS or FAILURE on the first tick, which means `hasInflightWork()` correctly reports no in-flight work when the tree is waiting at an `untilSuccess` suspension point.

```ts
actionReceived('approve')
// Returns a node (non-reactive, synchronous) that:
//   - Checks blackboard for `actions:approve`
//   - If found: consumes it (deletes key), returns SUCCESS
//   - If not found: returns FAILURE
```

With payload mapping:
```ts
actionReceived('approve', {
  mapPayload: (payload, blackboard) => {
    blackboard.set('review:decision', payload.decision)
    blackboard.set('review:comment', payload.comment)
  }
})
```

Returns FAILURE when no action is present — does not block the tree. Multiple `actionReceived()` nodes in a Selector each check for their action; the first match wins. The "waiting" happens at the `untilSuccess` decorator, not inside the condition.

**Critical invariant: consume-on-read safety.** When `actionReceived` succeeds, it deletes the blackboard key. If a later node in the same sequence fails or the tree is suspended mid-sequence, the action data is gone. The sequence doesn't re-tick `actionReceived` because its SUCCESS is cached in the sequence's `completedMap` (non-reactive nodes are skipped after returning a terminal status). On restore from serialized state, the `completedMap` must correctly reflect this cached SUCCESS — otherwise the sequence would re-tick `actionReceived`, find the key absent, return FAILURE, and silently drop the user's action with no recovery path. This makes faithful serialization and restoration of `completedMap` a correctness requirement, not just an optimization.

### untilSuccess() — decorator factory

Converts FAILURE to RUNNING, creating an explicit suspension point. The tree returns RUNNING at this node until its child succeeds.

```ts
untilSuccess(
  selector([
    sequence([actionReceived('approve'), ...]),
    sequence([actionReceived('reject'), ...]),
  ])
)
```

When the child returns FAILURE, `untilSuccess` returns RUNNING. Since no in-flight work exists, the tick loop exits and the tree is suspended. On the next message, the tree resumes here.

This is distinct from `RepeatNode` with `untilStatus: NodeStatus.SUCCESS`. `RepeatNode` re-ticks its child synchronously within a single `execute()` call and never returns RUNNING due to a child FAILURE — it loops internally. `untilSuccess` must return RUNNING to the caller on child FAILURE so that `runToCompletion()` can detect the suspension point via `hasInflightWork() === false`.

### emitToClient() — action factory

For the tree to send structured data to the UI beyond blackboard writes:

```ts
emitToClient('ui:show_review_form', (ctx) => ({
  document: ctx.blackboard.get('analysis:result'),
  options: ['approve', 'reject', 'request_changes']
}))
```

Performs a dual write:
1. **Blackboard** — writes the payload to `clientEvents:ui:show_review_form` so it's captured in the durable state snapshot. The client clears this key after processing (by sending a `write` message).
2. **Event** — emits a `'client:event'` event (a new entry in `TreeEvents`) with `{ name: string, data: unknown }` payload for real-time SSE delivery.

The blackboard entry is the source of truth. If the client misses the event (reconnect, transport gap), the next snapshot contains the pending client event and the client can react to it. The event is an optimization for real-time responsiveness, not a durability mechanism.

The client SDK maps these to friendly names — `client.on('ui:show_review_form', ...)` subscribes to `'client:event'` events where `name === 'ui:show_review_form'`. The UI reacts by rendering the appropriate component. When the user responds, they send an action message back, creating a dialogue between tree and UI.

---

## 7. Example: Full Application (Phase 1)

### Server

```ts
const server = new ActorServer({
  createTree: () => new BehaviorTree({
    name: 'document-review',
    root: sequence([
      agent({ name: 'analyze', prompt: 'Analyze the document...' }),
      emitToClient('ui:show_review', (ctx) => ({
        findings: ctx.blackboard.get('analyze:result')
      })),
      untilSuccess(
        selector([
          sequence([actionReceived('approve'), agent({ name: 'finalize', prompt: '...' })]),
          sequence([actionReceived('reject'),  agent({ name: 'archive',  prompt: '...' })]),
        ])
      ),
      agent({ name: 'notify', prompt: 'Notify stakeholders...' }),
    ])
  }),
  stateStore: new RedisStateStore({ url: process.env.REDIS_URL }),
})

await server.start()
```

### Client

```ts
const client = createCartographerClient('http://localhost:3148')
client.connect()

client.on('ui:show_review', ({ findings }) => {
  renderReviewForm(findings, {
    onApprove: () => client.action('approve'),
    onReject:  () => client.action('reject'),
  })
})

client.on('blackboard:write', ({ key, value }) => {
  updateUI(key, value)
})
```

---

# Phase 2: Sessions

Phase 2 adds multi-user support with isolated sessions. The processing loop, StateStore, serialization, locking, and event streaming are unchanged — sessions are a routing and lifecycle layer on top.

## 8. Session Model

Sessions are explicit, created via API, and fully isolated. Each session gets its own tree instance and blackboard — no shared state between sessions.

### Lifecycle

- **Create** — `POST /api/sessions` calls the tree factory, initializes a fresh blackboard, serializes both to the StateStore under a session-specific key, returns a session ID.
- **Use** — all message and read endpoints are session-scoped (e.g., `POST /api/sessions/:id/messages`).
- **Destroy** — `DELETE /api/sessions/:id` removes state from the StateStore.
- **Idle timeout** — configurable. If no message is received within the window, the session is cleaned up automatically.

### Tree Factory

The ActorServer already accepts a `createTree` factory (introduced in Phase 1). In Phase 2, each session calls `createTree()` to get a fresh instance. The existing TreeBuilder and TreeLoader (YAML config) both work as factories.

### Routing

The server is stateless — any instance can handle any session. On each request:
1. Extract session ID from the path
2. Load state from the StateStore (keyed by session ID)
3. Process message
4. Save state

No session affinity needed. Fly's load balancer can route freely across machines.

### Backward Compatibility

The Phase 1 root-level endpoints (`POST /api/messages`, `GET /api/blackboard`, etc.) remain as shortcuts for a default auto-created session. Existing clients and the Phase 1 dashboard continue to work without changes. The session-scoped endpoints are additive.

The default session uses the fixed ID `"default"`, is auto-created on first request to a root-level endpoint if it doesn't already exist, and persists across server restarts (stored in the StateStore like any other session). It cannot be deleted via `DELETE /api/sessions/default` — attempting to do so returns 409.

---

## 9. Session API

### Session Management Endpoints

- `POST /api/sessions` — create session, returns `{ sessionId, createdAt }`
- `GET /api/sessions` — list active sessions
- `DELETE /api/sessions/:id` — destroy session

### Session-Scoped Endpoints

All Phase 1 endpoints are available under `/api/sessions/:id/`:

- `GET /api/sessions/:id/tree`
- `GET /api/sessions/:id/status`
- `GET /api/sessions/:id/blackboard`
- `GET /api/sessions/:id/nodes/:nodeId`
- `GET /api/sessions/:id/events` — session-scoped SSE stream
- `POST /api/sessions/:id/messages`
- `POST /api/sessions/:id/actions/:name`
- `POST /api/sessions/:id/blackboard/:key`

---

## 10. Client SDK Extensions (Phase 2)

The Phase 1 client gains session support:

```ts
const client = createCartographerClient('http://localhost:3148')

// Session lifecycle
const session = await client.createSession()
await client.deleteSession(session.id)

// All Phase 1 operations are available on the session object
session.action('approve', { docId: '123' })
session.write('review:decision', 'approved')
const result = await session.actionAndWait('approve', { docId: '123' })
const state = await session.blackboard()

// Session-scoped SSE
session.on('blackboard:write', ({ key, value }) => { ... })
session.connect()
session.disconnect()
```

The Phase 1 client API (root-level, no sessions) continues to work — it operates on the default session.

---

## 11. Dashboard Changes (Phase 2)

The dashboard UI requires non-trivial changes to become session-aware. The Phase 1 dashboard assumes a single tree with root-level endpoints. With sessions, the dashboard needs:

- **Session picker** — list active sessions (`GET /api/sessions`), select one to inspect.
- **Session-scoped views** — all tree visualization, blackboard inspection, and event streams scoped to the selected session.
- **Session lifecycle controls** — create and destroy sessions from the dashboard.
- **Write controls** — send actions and blackboard writes to the selected session.

The reverse-proxy layer itself is unchanged (static files + API forwarding), but the Svelte frontend needs to be reworked around the session concept. This is a separate body of work.

---

# Shared

## 12. What Changes vs. What Stays

### Unchanged
- BehaviorTree core API (tick, reset, abort)
- All existing node types (ActionNode, AgentNode, ConditionNode, composites, decorators)
- Builder API
- EventEmitter, ObservableBlackboard
- YAML config loading

### Modified
- `BTreeNode` interface — adds `contentHash()`, `hasInflightWork()`, `inflightPromise()`, `serialize()`, `restore()` methods
- `BehaviorTree` — adds tree-level `hasInflightWork()`, `settled()`, and `rootHash` (computed from root node's content hash)
- `TreeEvents` — adds `'client:event'` entry with `{ name: string, data: unknown }` payload, `'message:processed'` entry with `{ messageId: string, treeStatus: string }` payload, and `'message:failed'` entry with `{ messageId: string, error: string }` payload
- `src/index.ts` — export new primitives

### New (Phase 1)
- `ActorServer` — `src/server/actor-server.ts`, HTTP layer with write endpoints
- `TreeActor` — `src/actor/tree-actor.ts`, internal transient per-message processor
- `StateStore` interface — `src/state/state-store.ts`
- `InMemoryStateStore` — `src/state/in-memory-state-store.ts`
- `RedisStateStore` — `src/state/redis-state-store.ts`
- `createCartographerClient` — `src/client/index.ts`
- `untilSuccess()` — `src/decorators/until-success.ts`
- `actionReceived()` — `src/nodes/action-received.ts`
- `emitToClient()` — `src/nodes/emit-to-client.ts`
- Actor message types — `src/actor/types.ts`
- Tree state serialization — `src/core/serialization.ts`

### New (Phase 2)
- Session management endpoints and routing in ActorServer
- Session extensions in client SDK

---

## 13. Architecture Layers

```
┌─────────────────────────────────────────────┐
│  Frontend (any framework)                   │
│  - Client SDK (createCartographerClient)    │
│  - SSE + REST                              │
├─────────────────────────────────────────────┤
│  ActorServer (HTTP layer)                   │
│  - Root-level endpoints (Phase 1)          │
│  - Session management + routing (Phase 2)  │
│  - Platform health endpoint                 │
├─────────────────────────────────────────────┤
│  StateStore (persistence layer)             │
│  - InMemoryStateStore (dev)                 │
│  - RedisStateStore (production)             │
│  - Tree state + locking + event streaming   │
├─────────────────────────────────────────────┤
│  TreeActor (execution layer, transient)     │
│  - Hydrate tree from factory + stored state │
│  - Process message → tick loop → serialize  │
│  - In-flight detection + suspension         │
├─────────────────────────────────────────────┤
│  BehaviorTree (logic layer)                 │
│  - Nodes: agents, conditions, actions       │
│  - Composites: sequence, selector, parallel │
│  - hasInflightWork() / settled()            │
├─────────────────────────────────────────────┤
│  Blackboard + Events (state layer)          │
│  - Observable KV store with scoping         │
│  - Typed event emitter                      │
│  - Full audit trail of all mutations        │
└─────────────────────────────────────────────┘
```

## 14. Deployment Modes

The ActorServer is the same code in every context. What changes between deployments is the StateStore and the process lifecycle.

### Local Development

`InMemoryStateStore`, no Redis needed. State disappears on restart. Useful for rapid iteration — run the server, test the tree, stop.

```ts
const server = new ActorServer({
  createTree: () => buildMyTree(),
  // stateStore defaults to InMemoryStateStore
})
```

SSE events are delivered directly (single process, no fan-out needed).

### Self-Hosted Production

`RedisStateStore` for durable state. The developer deploys the ActorServer to their own infrastructure (a VPS, a Docker container, Kubernetes, etc.) with a Redis instance. State survives server restarts. SSE fan-out works via Redis Streams.

```ts
const server = new ActorServer({
  createTree: () => buildMyTree(),
  stateStore: new RedisStateStore({ url: process.env.REDIS_URL }),
})
```

This is a fully functional production deployment — the same capabilities as PaaS, self-managed.

### Cartographer PaaS

Same as self-hosted, but the Cartographer control plane manages the process lifecycle: container deployment, health checks, scaling, secrets. The control plane injects `TENANT_ID`, `DEPLOYMENT_ID`, and `PORT=8080` as environment variables and health-checks `/_platform/health`.

```ts
const server = new ActorServer({
  createTree: () => buildMyTree(),
  stateStore: new RedisStateStore({ url: process.env.REDIS_URL }),
  context: {
    tenantId: process.env.TENANT_ID,
    deploymentId: process.env.DEPLOYMENT_ID,
  },
})
```

Structured JSON logging to stdout is used in all modes — the PaaS pipes it through Fly's log streaming infrastructure, and self-hosted deployments can route it to any log aggregator.

---

## 15. Future Considerations (Not in Scope)

These are natural extensions but not part of this design:

- **Authentication/authorization** — who can send which messages
- **WebSocket transport** — bidirectional streaming for lower latency
- **Framework bindings** — React hooks (`useCartographer`), Svelte stores
- **Multi-actor composition** — multiple trees communicating via messages
- **Supervision** — parent actors restarting crashed children
- **Metrics endpoint** — `/_platform/metrics` for Prometheus exposition, tracking request counts, agent invocations, token usage
- **Collaborative sessions** — multiple users interacting with a shared tree
- **Job queue processing** — BullMQ for message durability and independent worker scaling
