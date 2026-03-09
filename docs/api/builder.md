# Builder API Reference

## TreeBuilder

```typescript
import { TreeBuilder } from 'cartographer';
```

Extends `CompositeBuilder`.

**Constructor:** `new TreeBuilder(name: string)`

**Methods** (in addition to CompositeBuilder methods):

- `build(): BehaviorTree` — Creates a BehaviorTree from the builder. Throws if not exactly one root node.

**Example:**

```typescript
const tree = new TreeBuilder('my-tree')
  .selector('root', (b) => {
    b.action('task', (ctx) => NodeStatus.SUCCESS);
  })
  .build();
```

---

## CompositeBuilder

```typescript
import { CompositeBuilder } from 'cartographer';
```

Used to configure children of composite nodes. All methods return `this` for chaining.

### Leaf node methods

- `action(name: string, fn: (context: TreeContext) => Promise<NodeStatus> | NodeStatus): this`
- `condition(name: string, fn: (context: TreeContext) => Promise<boolean> | boolean): this`
- `agent(name: string, config: Omit<AgentNodeConfig, 'name'>): this`

### Composite methods

All composite methods accept two overloads:

1. `method(name, configure)` — no strategy
2. `method(name, { strategy }, configure)` — with strategy

#### selector

```typescript
selector(name: string, configure: (b: CompositeBuilder) => void): this
selector(name: string, options: { strategy?: SelectionStrategy }, configure: (b: CompositeBuilder) => void): this
```

#### sequence

```typescript
sequence(name: string, configure: (b: CompositeBuilder) => void): this
sequence(name: string, options: { strategy?: ExecutionStrategy }, configure: (b: CompositeBuilder) => void): this
```

#### parallel

```typescript
parallel(name: string, configure: (b: CompositeBuilder) => void): this
parallel(name: string, options: { strategy?: ParallelStrategy }, configure: (b: CompositeBuilder) => void): this
```

### Decorator methods

All decorator methods take `name`, options (if any), and a `configure: (b: SingleChildBuilder) => void` callback.

- `inverter(name: string, configure: (b: SingleChildBuilder) => void): this`
- `repeat(name: string, options: { count?: number; untilStatus?: NodeStatus }, configure: (b: SingleChildBuilder) => void): this`
- `retry(name: string, options: { maxAttempts: number; delayMs?: number }, configure: (b: SingleChildBuilder) => void): this`
- `alwaysSucceed(name: string, configure: (b: SingleChildBuilder) => void): this`
- `alwaysFail(name: string, configure: (b: SingleChildBuilder) => void): this`
- `timeout(name: string, options: { timeoutMs: number }, configure: (b: SingleChildBuilder) => void): this`
- `guard(name: string, options: { condition: (context: TreeContext) => Promise<boolean> | boolean }, configure: (b: SingleChildBuilder) => void): this`

### Internal method

- `getChildren(): BTreeNode[]` — Returns a copy of the children array. Used by `TreeBuilder.build()`.

---

## SingleChildBuilder

```typescript
import { SingleChildBuilder } from 'cartographer';
```

Used to configure the single child of decorator nodes. Has the same method signatures as CompositeBuilder (`action`, `condition`, `agent`, `selector`, `sequence`, `parallel`, `inverter`, `repeat`, `retry`, `alwaysSucceed`, `alwaysFail`, `timeout`, `guard`). Each method sets the child, replacing any previous child.

**Methods:**

- Same as CompositeBuilder, but each call sets a single child instead of appending.
- `getChild(): BTreeNode` — Returns the child node. Throws if no child is set: `"Decorator must have exactly one child node"`.

**Example:**

```typescript
const tree = new TreeBuilder('example')
  .sequence('main', (b) => {
    b.retry('with-retry', { maxAttempts: 3 }, (b) => {
      b.action('flaky-task', flakyTask);
    });
    b.timeout('with-timeout', { timeoutMs: 5000 }, (b) => {
      b.action('slow-task', slowTask);
    });
  })
  .build();
```
