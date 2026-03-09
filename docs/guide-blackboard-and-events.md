# State and Observability

Cartographer separates shared state (the blackboard) from observability (the event system). Both are available through the `TreeContext` passed to every node.

---

## Blackboard

`MapBlackboard` is the default implementation of the `Blackboard` interface. Pass initial values as a plain object to the constructor.

```typescript
import { MapBlackboard } from 'cartographer';

const bb = new MapBlackboard({ apiUrl: 'https://api.example.com', retries: 3 });
```

### Methods (Blackboard interface)

| Method | Signature | Description |
|--------|-----------|-------------|
| `get` | `get<T>(key: string): T \| undefined` | Retrieve a value by key. |
| `set` | `set<T>(key: string, value: T): void` | Store a value under the given key. |
| `has` | `has(key: string): boolean` | Check whether a key exists. |
| `delete` | `delete(key: string): void` | Remove a key and its value. |
| `keys` | `keys(): string[]` | List all stored keys. |
| `scoped` | `scoped(namespace: string): Blackboard` | Create a namespaced view (see below). |

`MapBlackboard` also exposes:

- `toRecord(): Record<string, unknown>` -- returns a snapshot of all stored data.

### Basic usage

```typescript
const bb = new MapBlackboard();
bb.set('user', { name: 'Alice', role: 'admin' });
bb.get<{ name: string; role: string }>('user'); // { name: 'Alice', role: 'admin' }
bb.has('user');   // true
bb.keys();        // ['user']
bb.delete('user');
bb.has('user');   // false
```

---

## Namespace Scoping

`scoped(namespace)` creates a prefixed view over the same underlying data. Keys are stored as `namespace:key`.

```typescript
const bb = new MapBlackboard();
const agentScope = bb.scoped('classifier');
agentScope.set('output', { label: 'positive' });

// Stored as 'classifier:output' in the underlying map
bb.get('classifier:output'); // { label: 'positive' }
agentScope.get('output');    // { label: 'positive' }
agentScope.keys();           // ['output']
```

Scoped blackboards can be nested: `bb.scoped('a').scoped('b')` stores keys as `a:b:key`.

`AgentNode` uses scoping automatically when `blackboardNamespace` is configured. The blackboard MCP server also respects the namespace, so the agent only sees its own scoped keys.

---

## Events

Cartographer uses a typed event system for observability. `BehaviorTree` creates an `EventEmitter<TreeEvents>` automatically, accessible via `tree.events`.

```typescript
import type { TypedEventEmitter, TreeEvents } from 'cartographer';
```

### Emitter interface

| Method | Description |
|--------|-------------|
| `on<K>(event, listener)` | Subscribe to an event. |
| `off<K>(event, listener)` | Unsubscribe a listener. |
| `emit<K>(event, data)` | Emit an event (used internally). |
| `removeAllListeners()` | Clear all subscriptions. |

---

## Event Reference

Cartographer emits eight event types during tree execution.

### `node:enter`

Fired when a node's `tick()` begins.

```typescript
{ node: BTreeNode; context: TreeContext }
```

### `node:exit`

Fired when a node's `tick()` completes (success or failure).

```typescript
{ node: BTreeNode; status: NodeStatus; context: TreeContext; durationMs: number }
```

### `node:error`

Fired when a node's `execute()` throws. The node still emits `node:exit` with `FAILURE` afterward.

```typescript
{ node: BTreeNode; error: Error; context: TreeContext }
```

### `agent:prompt`

Fired before an `AgentNode` calls the Claude SDK.

```typescript
{ node: BTreeNode; prompt: string; mode: 'structured' | 'agentic' }
```

### `agent:response`

Fired when an `AgentNode` receives a result from Claude.

```typescript
{ node: BTreeNode; result: unknown; cost?: number }
```

### `agent:tool_use`

Fired when an agentic-mode `AgentNode` processes a tool use block.

```typescript
{ node: BTreeNode; tool: string; input: unknown }
```

### `blackboard:write`

Fired when a blackboard write occurs (if emitted by the source).

```typescript
{ key: string; value: unknown; source: string }
```

### `strategy:decision`

Fired when an agent strategy makes a decision.

```typescript
{ composite: BTreeNode; strategy: string; decision: unknown }
```

---

## Practical Examples

### Logging listener

```typescript
import { TreeBuilder, NodeStatus } from 'cartographer';

const tree = new TreeBuilder('monitored')
  .sequence('main', (b) => {
    b.action('step-1', (ctx) => NodeStatus.SUCCESS);
    b.action('step-2', (ctx) => NodeStatus.SUCCESS);
  })
  .build();

tree.events.on('node:enter', ({ node }) => {
  console.log(`[ENTER] ${node.name}`);
});

tree.events.on('node:exit', ({ node, status, durationMs }) => {
  console.log(`[EXIT]  ${node.name} → ${status} (${durationMs.toFixed(1)}ms)`);
});

tree.events.on('node:error', ({ node, error }) => {
  console.error(`[ERROR] ${node.name}: ${error.message}`);
});

await tree.run();
```

### Cost tracking

```typescript
let totalCost = 0;
tree.events.on('agent:response', ({ node, cost }) => {
  if (cost !== undefined) {
    totalCost += cost;
    console.log(`Agent "${node.name}" cost: $${cost.toFixed(4)} (total: $${totalCost.toFixed(4)})`);
  }
});
```

### Per-node timing analysis

```typescript
const durations: Record<string, number[]> = {};

tree.events.on('node:exit', ({ node, durationMs }) => {
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

## Where to go next

- [Agent Integration](guide-agent-integration.md) -- connecting LLM agents to behavior tree nodes.
- [Building Trees](guide-building-trees.md) -- `TreeBuilder`, nesting, and construction patterns.
- [Decorator Nodes](guide-decorators.md) -- inverter, retry, guard, timeout, and more.
