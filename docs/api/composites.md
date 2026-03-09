# Composite Nodes

Composite nodes control the flow of execution by managing one or more child nodes. Cartographer provides three composite types: **SelectorNode**, **SequenceNode**, and **ParallelNode**.

---

## SelectorNode

```typescript
import { SelectorNode } from 'cartographer';
```

**Constructor:** `new SelectorNode(config: SelectorConfig)`

### SelectorConfig

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | Yes | — | Node name |
| `children` | `BTreeNode[]` | Yes | — | Child nodes |
| `strategy` | `SelectionStrategy` | No | `DefaultSelectionStrategy` | Ordering strategy |

### Behavior

1. Gets ordered children from `strategy.order(children, context)`.
2. Ticks each child in order.
3. First `SUCCESS` — returns `SUCCESS`.
4. First `RUNNING` — returns `RUNNING`.
5. All `FAILURE` — returns `FAILURE`.

### Inherited Methods

Methods inherited from `BaseNode`: `tick()`, `reset()` (resets all children), `abort()` (aborts all children).

### Example

```typescript
const node = new SelectorNode({
  name: 'fallback',
  children: [primaryAction, secondaryAction, defaultAction],
});
```

---

## SequenceNode

```typescript
import { SequenceNode } from 'cartographer';
```

**Constructor:** `new SequenceNode(config: SequenceConfig)`

### SequenceConfig

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | Yes | — | Node name |
| `children` | `BTreeNode[]` | Yes | — | Child nodes |
| `strategy` | `ExecutionStrategy` | No | `DefaultExecutionStrategy` | Ordering strategy |

### Behavior

1. Gets ordered children from `strategy.order(children, context)`.
2. Ticks each child in order.
3. First `FAILURE` — returns `FAILURE`.
4. First `RUNNING` — returns `RUNNING`.
5. All `SUCCESS` — returns `SUCCESS`.

### Inherited Methods

Methods inherited from `BaseNode`: `tick()`, `reset()` (resets all children), `abort()` (aborts all children).

### Example

```typescript
const node = new SequenceNode({
  name: 'pipeline',
  children: [validateInput, processData, saveResult],
});
```

---

## ParallelNode

```typescript
import { ParallelNode } from 'cartographer';
```

**Constructor:** `new ParallelNode(config: ParallelConfig)`

### ParallelConfig

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | Yes | — | Node name |
| `children` | `BTreeNode[]` | Yes | — | Child nodes |
| `strategy` | `ParallelStrategy` | No | `DefaultParallelStrategy` | Policy strategy |

### ParallelPolicy

| Field | Type | Description |
|-------|------|-------------|
| `successCount` | `number?` | Minimum successes required |
| `successPercentage` | `number?` | Minimum success percentage (0-100) |
| `failureCount` | `number?` | Failure count that triggers `FAILURE` |

### Behavior

1. Gets policy from `strategy.policy(children, context)`.
2. Ticks all children concurrently via `Promise.all`.
3. If any `RUNNING` — returns `RUNNING`.
4. If `failureCount` is set and failures >= `failureCount` — returns `FAILURE`.
5. If `successPercentage` is set and success% >= threshold — returns `SUCCESS`, else `FAILURE`.
6. If `successCount` is set and successes >= count — returns `SUCCESS`, else `FAILURE`.
7. Default (no fields set): all must succeed (any failure returns `FAILURE`).

### Inherited Methods

Methods inherited from `BaseNode`: `tick()`, `reset()` (resets all children), `abort()` (aborts all children).

### Example

```typescript
import { DefaultParallelStrategy } from 'cartographer';

const node = new ParallelNode({
  name: 'fan-out',
  children: [taskA, taskB, taskC],
  strategy: new DefaultParallelStrategy({ successCount: 2 }),
});
```
