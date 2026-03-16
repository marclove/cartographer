# Core API Reference

Core types, classes, and interfaces exported by `cartographer`.

---

## NodeStatus

```typescript
import { NodeStatus } from "cartographer";
```

Enum representing the result of a node tick.

| Value                | String      |
| -------------------- | ----------- |
| `NodeStatus.SUCCESS` | `'success'` |
| `NodeStatus.FAILURE` | `'failure'` |
| `NodeStatus.RUNNING` | `'running'` |

---

## BehaviorTree

```typescript
import { BehaviorTree } from "cartographer";
```

**Constructor:** `new BehaviorTree(config: BehaviorTreeConfig)`

### BehaviorTreeConfig

| Field           | Type            | Required | Description                                                                                                                                                                                                                      |
| --------------- | --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | `string`        | Yes      | Tree name                                                                                                                                                                                                                        |
| `root`          | `BTreeNode`     | Yes      | Root node                                                                                                                                                                                                                        |
| `blackboard`    | `Blackboard`    | No       | Defaults to `new InMemoryBlackboard()`                                                                                                                                                                                           |
| `onElicitation` | `OnElicitation` | No       | Default elicitation handler for all `AgentNode` descendants. When set, the root node's context overrides are updated so the handler is inherited throughout the tree. See [Elicitation](guide-agent-integration.md#elicitation). |

### Properties

| Property     | Type                                  | Description                                                  |
| ------------ | ------------------------------------- | ------------------------------------------------------------ |
| `name`       | `string` (readonly)                   | Tree name                                                    |
| `blackboard` | `Blackboard` (readonly)               | Shared blackboard instance                                   |
| `events`     | `EventEmitter<TreeEvents>` (readonly) | Event system for tree-level events                           |
| `root`       | `BTreeNode` (readonly)                | The root node of the tree                                    |
| `rootHash`   | `string` (getter)                     | Content hash of the root node — fingerprints the entire tree |

### Methods

| Method            | Signature                                                                  | Description                                                                                             |
| ----------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `tick`            | `(): Promise<NodeStatus>`                                                  | Tick the tree once. Creates a `TreeContext` from the blackboard, events, and an internal `AbortSignal`. |
| `run`             | `(): Promise<{ status: NodeStatus; blackboard: Record<string, unknown> }>` | Tick the tree and return the status together with a blackboard snapshot.                                |
| `reset`           | `(): void`                                                                 | Reset the root node and create a new `AbortController`.                                                 |
| `abort`           | `(): void`                                                                 | Abort the root node and signal abort via the internal controller.                                       |
| `interrupt`       | `(): void`                                                                 | Cancel in-flight work without destroying cycle state. No `reset()` needed. Emits `tree:interrupt`.      |
| `hasInflightWork` | `(): boolean`                                                              | Returns `true` if any node in the tree has unsettled async work.                                        |
| `settled`         | `(): Promise<void>`                                                        | Resolves when all in-flight work across the tree has settled.                                           |
| `start`           | `(options: { intervalMs: number; signal?: AbortSignal }): TickLoopHandle`  | Start a reactive tick loop. Returns a handle to stop it.                                                |

### Example

```typescript
const tree = new BehaviorTree({ name: "my-tree", root: myRootNode });
const { status, blackboard } = await tree.run();
```

---

## TickLoopHandle

```typescript
import type { TickLoopHandle } from "cartographer";
```

Handle returned by `BehaviorTree.start()` for stopping the tick loop.

```typescript
interface TickLoopHandle {
  stop(): Promise<void>;
}
```

| Method | Signature | Description |
| ------ | --------- | ----------- |
| `stop` | `(): Promise<void>` | Stop the tick loop and wait for any in-flight tick to complete. |

### Example

```typescript
const handle = tree.start({ intervalMs: 100 });
// ... later
await handle.stop();
```

---

## InMemoryBlackboard

```typescript
import { InMemoryBlackboard } from "cartographer";
```

Default `Blackboard` implementation backed by a `Map`.

**Constructor:** `new InMemoryBlackboard(initial?: Record<string, unknown>)`

### Methods

| Method     | Signature                          | Description                                                            |
| ---------- | ---------------------------------- | ---------------------------------------------------------------------- |
| `get`      | `<T>(key: string): T \| undefined` | Retrieve a value by key.                                               |
| `set`      | `<T>(key: string, value: T): void` | Store a value under the given key.                                     |
| `has`      | `(key: string): boolean`           | Check whether a key exists.                                            |
| `delete`   | `(key: string): void`              | Remove a key.                                                          |
| `keys`     | `(): string[]`                     | List all stored keys.                                                  |
| `scoped`   | `(namespace: string): Blackboard`  | Return a `ScopedBlackboard` that prefixes every key with `namespace:`. |
| `toRecord` | `(): Record<string, unknown>`      | Snapshot all key-value pairs as a plain object.                        |

### Example

```typescript
const bb = new InMemoryBlackboard({ count: 0 });
bb.set("name", "test");
bb.get<number>("count"); // 0
```

---

## EventEmitter

```typescript
import { EventEmitter } from "cartographer";
```

Typed event emitter implementing `TypedEventEmitter<TEvents>`.

**Constructor:** `new EventEmitter<TEvents>()`

### Methods

| Method               | Signature                                                    | Description                                          |
| -------------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| `on`                 | `<K>(event: K, listener: (data: TEvents[K]) => void): void` | Subscribe to an event.                               |
| `off`                | `<K>(event: K, listener: (data: TEvents[K]) => void): void` | Unsubscribe a listener.                              |
| `emit`               | `<K>(event: K, data: TEvents[K]): void`                     | Emit an event to all registered listeners.           |
| `onAny`              | `(listener: (event: string, data: unknown) => void): void`  | Subscribe to all events (wildcard listener).         |
| `offAny`             | `(listener: (event: string, data: unknown) => void): void`  | Unsubscribe a previously registered wildcard listener. |
| `removeAllListeners` | `(): void`                                                   | Remove every listener on every event.                |

---

## Blackboard (interface)

```typescript
import type { Blackboard } from "cartographer";
```

Contract for shared state storage used by all tree nodes.

| Method   | Signature                          |
| -------- | ---------------------------------- |
| `get`    | `<T>(key: string): T \| undefined` |
| `set`    | `<T>(key: string, value: T): void` |
| `has`    | `(key: string): boolean`           |
| `delete` | `(key: string): void`              |
| `keys`   | `(): string[]`                     |
| `scoped` | `(namespace: string): Blackboard`  |

---

## TreeContext (interface)

```typescript
import type { TreeContext } from "cartographer";
```

Propagated to every node on each tick. Nodes with context overrides shallow-merge their overrides before passing the context to descendants — `events` and `blackboard` are pinned and never overridden. See [Context Layering](../guide-advanced-patterns.md#context-layering).

| Field           | Type                            | Description                                                                                                                                                                 |
| --------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blackboard`    | `Blackboard`                    | Shared state accessible to all nodes                                                                                                                                        |
| `events`        | `TypedEventEmitter<TreeEvents>` | Event system for emitting tree-level events                                                                                                                                 |
| `signal`        | `AbortSignal \| undefined`      | Abort signal propagated from `BehaviorTree`                                                                                                                                 |
| `onElicitation` | `OnElicitation \| undefined`    | Elicitation handler inherited through context layering. `AgentNode` uses this when no node-level handler is set. See [Elicitation](guide-agent-integration.md#elicitation). |

---

## BTreeNode (interface)

```typescript
import type { BTreeNode } from "cartographer";
```

Base contract every behavior tree node must satisfy.

| Member            | Type                                                             | Description                                                       |
| ----------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| `id`              | `string` (readonly)                                              | Unique node identifier                                            |
| `name`            | `string` (readonly)                                              | Human-readable node name                                          |
| `children`        | `readonly BTreeNode[]` (readonly)                                | Direct children (empty for leaf nodes)                            |
| `tick`            | `(context: TreeContext) => Promise<NodeStatus>`                  | Execute one tick of this node                                     |
| `reset`           | `() => void`                                                     | Reset internal state                                              |
| `abort`           | `() => void`                                                     | Cancel any in-progress work (requires reset before next tick)     |
| `interrupt`       | `() => void`                                                     | Cancel in-flight work without destroying cycle state (no reset needed) |
| `hasInflightWork` | `() => boolean`                                                  | True if unsettled async work exists in this subtree               |
| `inflightPromise` | `() => Promise<void> \| null`                                   | Promise that resolves when all inflight work settles, or null     |
| `contentHash`     | `() => string`                                                   | Deterministic Merkle hash for serialization identity              |
| `serialize`       | `() => NodeState`                                                | Serialize execution state for persistence                         |
| `restore`         | `(state: NodeState, hashToNode: Map<string, BTreeNode>) => void` | Restore execution state from serialized data                      |

---

## TreeEvents (interface)

```typescript
import type { TreeEvents } from "cartographer";
```

Event map defining every event a tree can emit.

| Event                        | Payload                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `node:enter`                 | `{ node: BTreeNode; context: TreeContext }`                                                           |
| `node:exit`                  | `{ node: BTreeNode; status: NodeStatus; context: TreeContext; durationMs: number }`                   |
| `node:error`                 | `{ node: BTreeNode; error: Error; context: TreeContext }`                                             |
| `agent:prompt`               | `{ node: BTreeNode; prompt: string }`                                                                 |
| `agent:thinking`             | `{ node: BTreeNode; thinking: string }`                                                               |
| `agent:text`                 | `{ node: BTreeNode; text: string }`                                                                   |
| `agent:tool_use`             | `{ node: BTreeNode; tool: string; input: unknown }`                                                   |
| `agent:response`             | `{ node: BTreeNode; result: unknown; cost?: number; modelUsage?: Record<string, ModelUsage> }`                                                 |
| `agent:error`                | `{ node: BTreeNode; subtype: string; errors?: string[]; permissionDenials?: unknown; cost?: number; modelUsage?: Record<string, ModelUsage> }` |
| `agent:stream`               | `{ node: BTreeNode; event: unknown }`                                                                 |
| `agent:message`              | `{ node: BTreeNode; message: unknown }`                                                               |
| `agent:tool_progress`        | `{ node: BTreeNode; toolUseId: string; toolName: string; elapsedSeconds: number }`                    |
| `agent:init`                 | `{ node: BTreeNode; sessionId: string; model?: string; tools?: unknown; mcpServers?: unknown }`       |
| `agent:status`               | `{ node: BTreeNode; status: string }`                                                                 |
| `agent:rate_limit`           | `{ node: BTreeNode; info: unknown }`                                                                  |
| `tree:init`                  | `{ tree: string; root: string }`                                                                      |
| `tree:tick`                  | `{ tree: string; status: NodeStatus; durationMs: number }`                                            |
| `tree:reset`                 | `{ tree: string }`                                                                                    |
| `tree:abort`                 | `{ tree: string }`                                                                                    |
| `tree:interrupt`             | `{ tree: string }`                                                                                    |
| `tree:tick:skipped`          | `{ timestamp: number }`                                                                               |
| `blackboard:keys`            | `{ keys: string[]; source: string }`                                                                  |
| `blackboard:read`            | `{ key: string; value: unknown; hit: boolean; source: string }`                                       |
| `blackboard:write`           | `{ key: string; value: unknown; source: string }`                                                     |
| `agent:elicitation_declined` | `{ node: BTreeNode; request: ElicitationRequest }`                                                    |
| `strategy:decision`          | `{ composite: BTreeNode; strategy: string; decision: unknown }`                                       |
| `client:event`               | `{ name: string; data: unknown }`                                                                     |
| `message:processed`          | `{ messageId: string; treeStatus: string }`                                                           |
| `message:interrupted`        | `{ messageId: string }`                                                                               |
| `message:failed`             | `{ messageId: string; error: string }`                                                                |
