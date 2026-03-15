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

1. If no child order is committed for the current cycle, obtains it from `strategy.order(children, context)` and commits it.
2. Re-evaluates from child 0 on every tick. Reactive children are always re-ticked; non-reactive children use cached terminal results.
3. First `SUCCESS` — returns `SUCCESS` and clears the cycle.
4. First `RUNNING` — returns `RUNNING` (cycle preserved).
5. All `FAILURE` — returns `FAILURE` and clears the cycle.
6. **Preemption**: A higher-priority reactive child succeeding aborts lower-priority running children.

### Inherited Methods

Methods inherited from `BaseNode`: `tick()`, `reset()` (clears cycle caches, calls `strategy.reset?.()`, resets all children), `abort()` (aborts all children, clears cycle).

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

1. If no child order is committed for the current cycle, obtains it from `strategy.order(children, context)` and commits it.
2. Re-evaluates from child 0 on every tick. Reactive children are always re-ticked; non-reactive children use cached terminal results.
3. First `FAILURE` — returns `FAILURE` and clears the cycle.
4. First `RUNNING` — returns `RUNNING` (cycle preserved).
5. All `SUCCESS` — returns `SUCCESS` and clears the cycle.

### Inherited Methods

Methods inherited from `BaseNode`: `tick()`, `reset()` (clears cycle caches, calls `strategy.reset?.()`, resets all children), `abort()` (aborts all children, clears cycle).

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

1. Gets policy from `strategy.policy(children, context)` on the first tick of a cycle; commits it for the cycle.
2. Ticks all children concurrently. Reactive children are always re-ticked; non-reactive children use cached terminal results.
3. **Early termination** with partial results:
   - `failureCount` — if failures >= threshold, returns `FAILURE` immediately (even with RUNNING children).
   - `successCount` — if successes >= threshold, returns `SUCCESS`; if `successes + running < threshold`, returns `FAILURE`.
   - `successPercentage` — requires all children to complete (no early exit). Returns `SUCCESS` if percentage >= threshold, else `FAILURE`.
   - Default (no fields set): any failure returns `FAILURE`; any RUNNING returns `RUNNING`; all SUCCESS returns `SUCCESS`.

### Inherited Methods

Methods inherited from `BaseNode`: `tick()`, `reset()` (calls `strategy.reset?.()`, resets all children), `abort()` (aborts all children).

### Example

```typescript
import { DefaultParallelStrategy } from 'cartographer';

const node = new ParallelNode({
  name: 'fan-out',
  children: [taskA, taskB, taskC],
  strategy: new DefaultParallelStrategy({ successCount: 2 }),
});
```
