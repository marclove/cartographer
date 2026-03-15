# Agent-Enabled Application Framework — Design Spec

## Context

Cartographer's blackboard + event system already functions as a reactive state layer. The dashboard proves this: blackboard writes flow via SSE to Svelte runes, events provide a complete audit trail, and scoped namespaces partition state cleanly. The missing piece is *bidirectional communication* — the UI can observe state but can't write back. This design turns Cartographer from a behavior tree library into a general-purpose application framework where AI agents and human users collaborate through shared state and structured messages.

## Design Summary

Three new primitives, layered on the existing architecture:

1. **TreeActor** — wraps BehaviorTree with a mailbox for message-driven execution
2. **ActorServer** — extends TreeServer with write endpoints
3. **Client SDK** — connects frontends to the actor via HTTP/SSE

Everything else (BehaviorTree, nodes, blackboard, events, builder, scheduler) stays unchanged.

---

## 1. TreeActor

Thin wrapper around BehaviorTree. Adds a mailbox (FIFO queue) and sequential message processing.

### Message Types

| Type | Purpose | Triggers tick? |
|------|---------|----------------|
| `tick` | Scheduled or manual tick | Yes |
| `action` | Named user action with payload | Yes (writes payload to blackboard first) |
| `write` | Direct blackboard key/value update | Yes |
| `signal` | Control: stop, reset, abort | No (handled by actor) |

### Processing Loop

```
receive(msg):
  mailbox.enqueue(msg)
  if not processing: drainMailbox()

drainMailbox():
  processing = true
  while mailbox has messages:
    msg = mailbox.dequeue()
    if msg.type == 'action':
      blackboard.set(`actions:${msg.name}`, msg.payload)
      emit('actor:message:received', msg)
      tree.tick()
    if msg.type == 'write':
      blackboard.set(msg.key, msg.value)
      tree.tick()
    if msg.type == 'tick':
      tree.tick()
    if msg.type == 'signal':
      handleSignal(msg)
  processing = false
```

### Guarantees

- **Sequential processing** — one message fully processed (tick completes) before the next begins
- **No concurrent blackboard mutation** — the mailbox serializes all state changes
- **Backpressure** — messages arriving during a tick are queued, not dropped

### API

```ts
const actor = new TreeActor(tree, options?)

actor.send(msg)       // enqueue a message (can be called anytime)
actor.start()         // begin processing mailbox
actor.stop()          // drain remaining messages, then stop
```

Events flow through `tree.events` as today — the actor adds no new event system.

### Scheduler Integration

The existing TreeScheduler becomes a message source. Instead of directly calling `tree.tick()`, it sends `{ type: 'tick' }` messages to the actor's mailbox. Scheduled ticks, user actions, and external events all flow through the same pipeline.

---

## 2. ActorServer

Replaces TreeServer as the HTTP layer over the actor.

### Read Endpoints (unchanged from TreeServer)

- `GET /api/tree` — serialized tree structure
- `GET /api/status` — tick count, last status, uptime
- `GET /api/blackboard` — current blackboard snapshot
- `GET /api/nodes/:id` — node details
- `GET /events` — SSE stream (snapshot on connect, incremental events)

### New Write Endpoints

- `POST /api/messages` — send any message to the actor mailbox
  ```json
  { "type": "action", "name": "approve", "payload": { "docId": "123" } }
  ```
  Returns: `{ "id": "msg-1", "queued": true }`

- `POST /api/actions/:name` — convenience for actions
  ```json
  { "docId": "123", "comment": "Looks good" }
  ```
  Equivalent to `POST /api/messages { type: "action", name: ":name", payload: body }`

- `POST /api/blackboard/:key` — convenience for writes
  ```json
  { "value": "approved" }
  ```

### Transport

REST for sends + SSE for events. Pragmatic, works with existing dashboard architecture, easy to debug with curl. WebSocket can be added later for latency-sensitive use cases.

### DashboardServer

Continues to reverse-proxy to ActorServer. No structural changes needed.

---

## 3. Client SDK

Lightweight client for connecting frontends to a Cartographer actor.

```ts
const client = createCartographerClient('http://localhost:3148')

// Send messages
client.send({ type: 'action', name: 'approve', payload: { docId: '123' } })
client.action('approve', { docId: '123' })      // convenience
client.write('review:decision', 'approved')       // convenience

// Read state (one-shot)
const state = await client.blackboard()
const tree = await client.tree()

// Subscribe to events (wraps EventSource/SSE)
client.on('blackboard:write', ({ key, value }) => { ... })
client.on('agent:response', ({ node, result }) => { ... })
client.onAny((event, data) => { ... })

// Connection lifecycle
client.connect()     // opens SSE
client.disconnect()  // closes SSE
```

The client mirrors the TypedEventEmitter interface for subscriptions — same mental model on both sides. Framework-specific bindings (React hooks, Svelte stores) would be separate packages built on top.

---

## 4. Tree Interaction Patterns

### actionReceived() — condition factory

When the actor processes an action message, it writes the payload to `actions:<name>` on the blackboard, then ticks the tree. The `actionReceived()` factory returns a ConditionNode that checks for this key.

```ts
actionReceived('approve')
// Returns a ConditionNode that:
//   - Checks blackboard for `actions:approve`
//   - If found: consumes it (deletes key), returns true (SUCCESS)
//   - If not found: returns false (FAILURE)
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

Returns FAILURE when no action is present — does not block the tree. Multiple `actionReceived()` nodes in a Selector each check for their action; the first match wins. The "waiting" happens at the actor level (between ticks), not inside the tree.

### emitToClient() — event factory

For the tree to send structured data to the UI beyond blackboard writes:

```ts
emitToClient('ui:show_review_form', (ctx) => ({
  document: ctx.blackboard.get('analysis:result'),
  options: ['approve', 'reject', 'request_changes']
}))
```

Emits a custom event that flows through SSE to the client. The UI reacts by rendering the appropriate component. When the user responds, they send an action message back, creating a dialogue between tree and UI.

---

## 5. Example: Full Application

### Server

```ts
const tree = new BehaviorTree({
  name: 'document-review',
  root: sequence([
    agent({ name: 'analyze', prompt: 'Analyze the document...' }),
    emitToClient('ui:show_review', (ctx) => ({
      findings: ctx.blackboard.get('analyze:result')
    })),
    selector([
      sequence([actionReceived('approve'), agent({ name: 'finalize', prompt: '...' })]),
      sequence([actionReceived('reject'),  agent({ name: 'archive',  prompt: '...' })]),
    ]),
    agent({ name: 'notify', prompt: 'Notify stakeholders...' }),
  ])
})

const actor = new TreeActor(tree)
const server = new ActorServer(actor, { port: 3148 })
await server.start()
await actor.start()
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

## 6. What Changes vs. What Stays

### Unchanged
- BehaviorTree API
- All node types (ActionNode, AgentNode, ConditionNode, composites, decorators)
- Builder API
- Blackboard, EventEmitter, ObservableBlackboard
- TreeEvents type
- Serializers, EventBuffer, SSE handler
- YAML config loading

### New
- `TreeActor` — `src/actor/tree-actor.ts`
- `ActorServer` — `src/server/actor-server.ts` (extends or replaces TreeServer)
- `createCartographerClient` — `src/client/index.ts`
- `actionReceived()` — `src/nodes/action-received.ts` (condition factory)
- `emitToClient()` — `src/nodes/emit-to-client.ts` (action factory)
- Actor message types — `src/actor/types.ts`
- Write endpoint handlers — `src/server/write-handlers.ts`

### Modified
- `src/index.ts` — export new primitives
- `src/cli/commands/run.ts` — use ActorServer instead of TreeServer
- Dashboard may gain write capability (send actions via the new endpoints)

---

## 7. Architecture Layers

```
┌─────────────────────────────────────────────┐
│  Frontend (any framework)                   │
│  - Client SDK (createCartographerClient)    │
│  - SSE for events, REST for messages        │
├─────────────────────────────────────────────┤
│  ActorServer (HTTP layer)                   │
│  - Read endpoints (tree, blackboard, nodes) │
│  - Write endpoints (messages, actions)      │
│  - SSE event stream                         │
├─────────────────────────────────────────────┤
│  TreeActor (execution layer)                │
│  - Mailbox (FIFO message queue)             │
│  - Sequential processing                   │
│  - Message → blackboard write → tick        │
├─────────────────────────────────────────────┤
│  BehaviorTree (logic layer)                 │
│  - Nodes: agents, conditions, actions       │
│  - Composites: sequence, selector, parallel │
│  - Strategies: default + agent-powered      │
├─────────────────────────────────────────────┤
│  Blackboard + Events (state layer)          │
│  - Observable KV store with scoping         │
│  - Typed event emitter                      │
│  - Full audit trail of all mutations        │
└─────────────────────────────────────────────┘
```

## 8. Future Considerations (Not in Scope)

These are natural extensions but not part of this design:

- **Persistence** — blackboard is in-memory today; persisting to disk/DB would enable durable applications
- **Authentication/authorization** — who can send which messages
- **WebSocket transport** — bidirectional streaming for lower latency
- **Framework bindings** — React hooks (`useCartographer`), Svelte stores
- **Multi-actor composition** — multiple trees communicating via messages
- **Supervision** — parent actors restarting crashed children
