# Core API Reference

Core types, classes, and interfaces exported by `cartographer`.

---

## NodeStatus

```typescript
import { NodeStatus } from 'cartographer';
```

Enum representing the result of a node tick.

| Value | String |
|-------|--------|
| `NodeStatus.SUCCESS` | `'success'` |
| `NodeStatus.FAILURE` | `'failure'` |
| `NodeStatus.RUNNING` | `'running'` |

---

## BehaviorTree

```typescript
import { BehaviorTree } from 'cartographer';
```

**Constructor:** `new BehaviorTree(config: BehaviorTreeConfig)`

### BehaviorTreeConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Tree name |
| `root` | `BTreeNode` | Yes | Root node |
| `blackboard` | `Blackboard` | No | Defaults to `new MapBlackboard()` |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` (readonly) | Tree name |
| `blackboard` | `Blackboard` (readonly) | Shared blackboard instance |
| `events` | `EventEmitter<TreeEvents>` (readonly) | Event system for tree-level events |

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `tick` | `(): Promise<NodeStatus>` | Tick the tree once. Creates a `TreeContext` from the blackboard, events, and an internal `AbortSignal`. |
| `run` | `(): Promise<{ status: NodeStatus; blackboard: Record<string, unknown> }>` | Tick the tree and return the status together with a blackboard snapshot. |
| `reset` | `(): void` | Reset the root node and create a new `AbortController`. |
| `abort` | `(): void` | Abort the root node and signal abort via the internal controller. |

### Example

```typescript
const tree = new BehaviorTree({ name: 'my-tree', root: myRootNode });
const { status, blackboard } = await tree.run();
```

---

## MapBlackboard

```typescript
import { MapBlackboard } from 'cartographer';
```

Default `Blackboard` implementation backed by a `Map`.

**Constructor:** `new MapBlackboard(initial?: Record<string, unknown>)`

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `get` | `<T>(key: string): T \| undefined` | Retrieve a value by key. |
| `set` | `<T>(key: string, value: T): void` | Store a value under the given key. |
| `has` | `(key: string): boolean` | Check whether a key exists. |
| `delete` | `(key: string): void` | Remove a key. |
| `keys` | `(): string[]` | List all stored keys. |
| `scoped` | `(namespace: string): Blackboard` | Return a `ScopedBlackboard` that prefixes every key with `namespace:`. |
| `toRecord` | `(): Record<string, unknown>` | Snapshot all key-value pairs as a plain object. |

### Example

```typescript
const bb = new MapBlackboard({ count: 0 });
bb.set('name', 'test');
bb.get<number>('count'); // 0
```

---

## EventEmitter

```typescript
import { EventEmitter } from 'cartographer';
```

Typed event emitter implementing `TypedEventEmitter<TEvents>`.

**Constructor:** `new EventEmitter<TEvents>()`

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `on` | `<K>(event: K, listener: (data: TEvents[K]) => void): void` | Subscribe to an event. |
| `off` | `<K>(event: K, listener: (data: TEvents[K]) => void): void` | Unsubscribe a listener. |
| `emit` | `<K>(event: K, data: TEvents[K]): void` | Emit an event to all registered listeners. |
| `removeAllListeners` | `(): void` | Remove every listener on every event. |

---

## Blackboard (interface)

```typescript
import type { Blackboard } from 'cartographer';
```

Contract for shared state storage used by all tree nodes.

| Method | Signature |
|--------|-----------|
| `get` | `<T>(key: string): T \| undefined` |
| `set` | `<T>(key: string, value: T): void` |
| `has` | `(key: string): boolean` |
| `delete` | `(key: string): void` |
| `keys` | `(): string[]` |
| `scoped` | `(namespace: string): Blackboard` |

---

## TreeContext (interface)

```typescript
import type { TreeContext } from 'cartographer';
```

Passed to every node on each tick.

| Field | Type | Description |
|-------|------|-------------|
| `blackboard` | `Blackboard` | Shared state accessible to all nodes |
| `events` | `TypedEventEmitter<TreeEvents>` | Event system for emitting tree-level events |
| `signal` | `AbortSignal \| undefined` | Abort signal propagated from `BehaviorTree` |

---

## BTreeNode (interface)

```typescript
import type { BTreeNode } from 'cartographer';
```

Base contract every behavior tree node must satisfy.

| Member | Type | Description |
|--------|------|-------------|
| `id` | `string` (readonly) | Unique node identifier |
| `name` | `string` (readonly) | Human-readable node name |
| `tick` | `(context: TreeContext) => Promise<NodeStatus>` | Execute one tick of this node |
| `reset` | `() => void` | Reset internal state |
| `abort` | `() => void` | Cancel any in-progress work |

---

## TreeEvents (interface)

```typescript
import type { TreeEvents } from 'cartographer';
```

Event map defining every event a tree can emit.

| Event | Payload |
|-------|---------|
| `node:enter` | `{ node: BTreeNode; context: TreeContext }` |
| `node:exit` | `{ node: BTreeNode; status: NodeStatus; context: TreeContext; durationMs: number }` |
| `node:error` | `{ node: BTreeNode; error: Error; context: TreeContext }` |
| `agent:prompt` | `{ node: BTreeNode; prompt: string; mode: 'structured' \| 'unstructured' }` |
| `agent:thinking` | `{ node: BTreeNode; thinking: string }` |
| `agent:text` | `{ node: BTreeNode; text: string }` |
| `agent:tool_use` | `{ node: BTreeNode; tool: string; input: unknown }` |
| `agent:response` | `{ node: BTreeNode; result: unknown; cost?: number }` |
| `agent:error` | `{ node: BTreeNode; subtype: string; errors?: string[]; permissionDenials?: unknown; cost?: number }` |
| `agent:stream` | `{ node: BTreeNode; event: unknown }` |
| `agent:message` | `{ node: BTreeNode; message: unknown }` |
| `agent:tool_progress` | `{ node: BTreeNode; toolUseId: string; toolName: string; elapsedSeconds: number }` |
| `agent:init` | `{ node: BTreeNode; sessionId: string; model?: string; tools?: unknown; mcpServers?: unknown }` |
| `agent:status` | `{ node: BTreeNode; status: string }` |
| `agent:rate_limit` | `{ node: BTreeNode; info: unknown }` |
| `blackboard:write` | `{ key: string; value: unknown; source: string }` |
| `strategy:decision` | `{ composite: BTreeNode; strategy: string; decision: unknown }` |
