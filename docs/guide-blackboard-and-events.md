# State and Observability

Cartographer separates shared state (the blackboard) from observability (the event system). Both are available through the `TreeContext` passed to every node.

---

## Blackboard

`InMemoryBlackboard` is the default implementation of the `Blackboard` interface. Pass initial values as a plain object to the constructor.

```typescript
import { InMemoryBlackboard } from "cartographer";

const bb = new InMemoryBlackboard({ apiUrl: "https://api.example.com", retries: 3 });
```

### Methods (Blackboard interface)

| Method   | Signature                               | Description                           |
| -------- | --------------------------------------- | ------------------------------------- |
| `get`    | `get<T>(key: string): T \| undefined`   | Retrieve a value by key.              |
| `set`    | `set<T>(key: string, value: T): void`   | Store a value under the given key.    |
| `has`    | `has(key: string): boolean`             | Check whether a key exists.           |
| `delete` | `delete(key: string): void`             | Remove a key and its value.           |
| `keys`   | `keys(): string[]`                      | List all stored keys.                 |
| `scoped` | `scoped(namespace: string): Blackboard` | Create a namespaced view (see below). |

`InMemoryBlackboard` also exposes:

- `toRecord(): Record<string, unknown>` -- returns a snapshot of all stored data.

### Basic usage

```typescript
const bb = new InMemoryBlackboard();
bb.set("user", { name: "Alice", role: "admin" });
bb.get<{ name: string; role: string }>("user"); // { name: 'Alice', role: 'admin' }
bb.has("user"); // true
bb.keys(); // ['user']
bb.delete("user");
bb.has("user"); // false
```

---

## Namespace Scoping

`scoped(namespace)` creates a prefixed view over the same underlying data. Keys are stored as `namespace:key`.

```typescript
const bb = new InMemoryBlackboard();
const agentScope = bb.scoped("classifier");
agentScope.set("output", { label: "positive" });

// Stored as 'classifier:output' in the underlying map
bb.get("classifier:output"); // { label: 'positive' }
agentScope.get("output"); // { label: 'positive' }
agentScope.keys(); // ['output']
```

Scoped blackboards can be nested: `bb.scoped('a').scoped('b')` stores keys as `a:b:key`.

`AgentNode` uses scoping automatically when `blackboardNamespace` is configured. The blackboard MCP server also respects the namespace, so the agent only sees its own scoped keys.

---

## Events

Cartographer uses a typed event system for observability. `BehaviorTree` creates an `EventEmitter<TreeEvents>` automatically, accessible via `tree.events`.

```typescript
import type { TypedEventEmitter, TreeEvents } from "cartographer";
```

### Emitter interface

| Method                    | Description                                  |
| ------------------------- | -------------------------------------------- |
| `on<K>(event, listener)`  | Subscribe to an event.                       |
| `off<K>(event, listener)` | Unsubscribe a listener.                      |
| `emit<K>(event, data)`    | Emit an event (used internally).             |
| `onAny(listener)`         | Subscribe to all events (wildcard listener). |
| `offAny(listener)`        | Unsubscribe a wildcard listener.             |
| `removeAllListeners()`    | Clear all subscriptions.                     |

---

## Event Reference

Cartographer emits events during tree execution, organized into four categories: node lifecycle, agent activity, data flow, and strategy decisions.

### `node:enter`

Fired when a node's `tick()` begins.

```typescript
{
  node: BTreeNode;
  context: TreeContext;
}
```

### `node:exit`

Fired when a node's `tick()` completes (success or failure).

```typescript
{
  node: BTreeNode;
  status: NodeStatus;
  context: TreeContext;
  durationMs: number;
}
```

### `node:error`

Fired when a node's `execute()` throws. The node still emits `node:exit` with `FAILURE` afterward.

```typescript
{
  node: BTreeNode;
  error: Error;
  context: TreeContext;
}
```

### `agent:prompt`

Fired before an `AgentNode` sends a prompt to the agent.

```typescript
{
  node: BTreeNode;
  prompt: string;
}
```

### `agent:thinking`

Fired when the agent produces a thinking block (chain-of-thought reasoning). Only emitted by agents that implement `ThinkingCapable`.

```typescript
{
  node: BTreeNode;
  thinking: string;
}
```

### `agent:text`

Fired when the agent produces a text content block.

```typescript
{
  node: BTreeNode;
  text: string;
}
```

### `agent:tool_use`

Fired for each tool call made by the agent.

```typescript
{
  node: BTreeNode;
  tool: string;
  input: unknown;
}
```

### `agent:response`

Fired when an `AgentNode` receives a successful result from the agent.

```typescript
{ node: BTreeNode; result: unknown; cost?: number; modelUsage?: Record<string, ModelUsage> }
```

### `agent:error`

Fired when the agent returns an error result (e.g., max turns exceeded, budget exhausted, execution error).

```typescript
{ node: BTreeNode; subtype: string; errors?: string[]; permissionDenials?: unknown; cost?: number; modelUsage?: Record<string, ModelUsage> }
```

### `agent:stream`

Fired for each raw streaming event from agents that implement `StreamCapable`. High-frequency — useful for real-time token-by-token UI updates.

```typescript
{
  node: BTreeNode;
  event: unknown;
}
```

### `agent:message`

Fired for every raw agent message. A catch-all that enables custom processing without framework filtering. Also high-frequency.

```typescript
{
  node: BTreeNode;
  message: unknown;
}
```

### `agent:tool_progress`

Fired when the agent reports tool execution progress with elapsed time.

```typescript
{
  node: BTreeNode;
  toolUseId: string;
  toolName: string;
  elapsedSeconds: number;
}
```

### `agent:init`

Fired when the agent emits a session init message with model, tools, and config details.

```typescript
{ node: BTreeNode; sessionId: string; model?: string; tools?: unknown; mcpServers?: unknown }
```

### `agent:status`

Fired when the agent emits a status change during execution.

```typescript
{
  node: BTreeNode;
  status: string;
}
```

### `agent:rate_limit`

Fired when the agent reports a rate limit event.

```typescript
{
  node: BTreeNode;
  info: unknown;
}
```

### `agent:elicitation_declined`

Fired when an `AgentNode` receives an elicitation request but no handler is configured at any level (node, context, or tree). The request is automatically declined.

```typescript
{
  node: BTreeNode;
  request: AgentElicitationRequest;
}
```

See [Elicitation](guide-agent-integration.md#elicitation) for how to provide handlers.

### `tree:init`

Fired when a `BehaviorTree` is constructed, after ID uniqueness validation passes.

```typescript
{
  tree: string;
  root: string;
}
```

### `tree:tick`

Fired after each `BehaviorTree.tick()` completes, with the final status and duration.

```typescript
{
  tree: string;
  status: NodeStatus;
  durationMs: number;
}
```

### `tree:reset`

Fired when `BehaviorTree.reset()` is called.

```typescript
{
  tree: string;
}
```

### `tree:abort`

Fired when `BehaviorTree.abort()` is called.

```typescript
{
  tree: string;
}
```

### `tree:interrupt`

Fired when `BehaviorTree.interrupt()` is called. Unlike `tree:abort`, the tree remains tickable without needing `reset()`.

```typescript
{
  tree: string;
}
```

### `tree:tick:skipped`

Fired when a scheduled tick is skipped because the previous tick is still in progress (requires `skipOnOverlap: true` on the scheduler).

```typescript
{
  timestamp: number;
}
```

### `blackboard:keys`

Fired when blackboard keys are enumerated.

```typescript
{ keys: string[]; source: string }
```

### `blackboard:read`

Fired when a value is read from the blackboard.

```typescript
{
  key: string;
  value: unknown;
  hit: boolean;
  source: string;
}
```

### `blackboard:write`

Fired when a blackboard write occurs.

```typescript
{
  key: string;
  value: unknown;
  source: string;
}
```

### `strategy:decision`

Fired when an agent strategy makes a decision.

```typescript
{
  composite: BTreeNode;
  strategy: string;
  decision: unknown;
}
```

### `client:event`

Fired by `emitToClient` nodes when they push data to the client. Used by the [application server](guide-app-server.md) SSE endpoint to deliver real-time updates.

```typescript
{
  name: string;
  data: unknown;
}
```

### `message:processed`

Fired by `ActorServer` when a message completes processing successfully. Subscribers (including the client SDK's `commandAndWait`) use this to detect completion.

```typescript
{
  messageId: string;
  treeStatus: string;
}
```

### `message:interrupted`

Fired by `ActorServer` when an in-progress message is interrupted via `POST /api/interrupt`. Fires _before_ the `message:processed` event, giving the client context for why the tree is now suspended.

```typescript
{
  messageId: string;
}
```

### `message:failed`

Fired by `ActorServer` when processing a message throws an error.

```typescript
{
  messageId: string;
  error: string;
}
```

---

## Practical Examples

### Logging listener

```typescript
import { TreeBuilder, NodeStatus } from "cartographer";

const tree = new TreeBuilder("monitored")
  .sequence("main", (b) => {
    b.action("step-1", (ctx) => NodeStatus.SUCCESS);
    b.action("step-2", (ctx) => NodeStatus.SUCCESS);
  })
  .build();

tree.events.on("node:enter", ({ node }) => {
  console.log(`[ENTER] ${node.name}`);
});

tree.events.on("node:exit", ({ node, status, durationMs }) => {
  console.log(`[EXIT]  ${node.name} → ${status} (${durationMs.toFixed(1)}ms)`);
});

tree.events.on("node:error", ({ node, error }) => {
  console.error(`[ERROR] ${node.name}: ${error.message}`);
});

await tree.run();
```

### Cost tracking

```typescript
let totalCost = 0;
tree.events.on("agent:response", ({ node, cost }) => {
  if (cost !== undefined) {
    totalCost += cost;
    console.log(`Agent "${node.name}" cost: $${cost.toFixed(4)} (total: $${totalCost.toFixed(4)})`);
  }
});
```

### Per-node timing analysis

```typescript
const durations: Record<string, number[]> = {};

tree.events.on("node:exit", ({ node, durationMs }) => {
  if (!durations[node.name]) durations[node.name] = [];
  durations[node.name].push(durationMs);
});

// After running multiple ticks:
for (const [name, times] of Object.entries(durations)) {
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`${name}: avg ${avg.toFixed(1)}ms over ${times.length} ticks`);
}
```

---

## Structured Logging with createTreeLogger

`createTreeLogger` is a utility that attaches to the tree's event emitter and appends structured log entries to a file in NDJSON format (one JSON object per line). This makes it easy to capture a full trace of tree execution for debugging, auditing, or analysis.

```typescript
import { BehaviorTree, createTreeLogger } from "cartographer";

const tree = new BehaviorTree({ name: "my-tree", root, blackboard });

const stopLogging = createTreeLogger(tree.events, { filePath: "./logs/run.log" });
await tree.tick();
stopLogging(); // remove listeners when done
```

The logger captures all meaningful events — node lifecycle, agent activity, strategy decisions — while intentionally excluding the two high-frequency events (`agent:stream` and `agent:message`) that would dominate the log. The log directory is created automatically if it does not exist.

Each log line is a JSON object with a `ts` (ISO timestamp), a monotonically increasing `seq`, an `event` field, and event-specific data:

```jsonl
{"ts":"2026-03-10T07:00:00.000Z","seq":1,"event":"node:enter","node":"classify"}
{"ts":"2026-03-10T07:00:00.123Z","seq":2,"event":"agent:prompt","node":"classify","prompt":"..."}
{"ts":"2026-03-10T07:00:01.456Z","seq":3,"event":"agent:response","node":"classify","result":{...},"cost":0.0012}
{"ts":"2026-03-10T07:00:01.457Z","seq":4,"event":"node:exit","node":"classify","status":"success","durationMs":1457}
```

You can inspect logs with `jq`:

```sh
# Pretty-print the full log
cat run.log | jq .

# Filter to agent tool calls only
cat run.log | jq 'select(.event == "agent:tool_use")'

# Tail a running log in real time
tail -f run.log | jq .
```

### Options

| Option          | Type      | Default    | Description                                                                                       |
| --------------- | --------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `filePath`      | `string`  | (required) | Path to the log file. Created if it does not exist.                                               |
| `logBlackboard` | `boolean` | `false`    | Include `blackboard:write` events. Off by default because blackboard writes can be very frequent. |
| `logStrategy`   | `boolean` | `true`     | Include `strategy:decision` events.                                                               |

The function returns a cleanup callback that removes all listeners. Call it when the tree is done to prevent memory leaks.

---

## Where to go next

- [Agent Integration](guide-agent-integration.md) -- connecting LLM agents to behavior tree nodes.
- [Building Trees](guide-building-trees.md) -- `TreeBuilder`, nesting, and construction patterns.
- [Decorator Nodes](guide-decorators.md) -- inverter, retry, guard, timeout, and more.
- [CLI Runner](guide-cli.md) -- the CLI formatter consumes tree events to render structured output.
