# Composites and Strategies

Composite nodes contain children and define how those children are ticked. Cartographer provides three composites — `SelectorNode`, `SequenceNode`, and `ParallelNode` — each with a pluggable strategy that controls ordering or policy.

---

## SelectorNode

"Try until one works." Ticks children in order and returns the first `SUCCESS` or `RUNNING` result. If every child fails, the selector fails.

### Config

```typescript
interface SelectorConfig {
  name: string;
  children: BTreeNode[];
  strategy?: SelectionStrategy;
}
```

### Behavior

1. Obtains the child list from `strategy.order()` (default: original insertion order).
2. Ticks each child in sequence.
3. First child returning `SUCCESS` — selector returns `SUCCESS`.
4. First child returning `RUNNING` — selector returns `RUNNING`.
5. All children return `FAILURE` — selector returns `FAILURE`.

### Example

```typescript
import { SelectorNode, ActionNode, NodeStatus } from 'cartographer';

const selector = new SelectorNode({
  name: 'try-sources',
  children: [
    new ActionNode({ name: 'try-cache', action: tryCache }),
    new ActionNode({ name: 'try-api', action: tryApi }),
    new ActionNode({ name: 'use-default', action: useDefault }),
  ],
});
```

---

## SequenceNode

"Do all in order." Ticks children in order and returns the first `FAILURE` or `RUNNING` result. If every child succeeds, the sequence succeeds.

### Config

```typescript
interface SequenceConfig {
  name: string;
  children: BTreeNode[];
  strategy?: ExecutionStrategy;
}
```

### Behavior

1. Obtains the child list from `strategy.order()` (default: original insertion order).
2. Ticks each child in sequence.
3. First child returning `FAILURE` — sequence returns `FAILURE`.
4. First child returning `RUNNING` — sequence returns `RUNNING`.
5. All children return `SUCCESS` — sequence returns `SUCCESS`.

---

## ParallelNode

Runs all children concurrently via `Promise.all`, then applies a policy to determine the composite result.

### Config

```typescript
interface ParallelConfig {
  name: string;
  children: BTreeNode[];
  strategy?: ParallelStrategy;
}

interface ParallelPolicy {
  successCount?: number;
  successPercentage?: number;
  failureCount?: number;
}
```

### Behavior

1. All children tick concurrently.
2. If any child returns `RUNNING` — parallel returns `RUNNING`.
3. Policy evaluation (checked in this order):
   - `failureCount` — if failures >= `failureCount`, return `FAILURE`.
   - `successPercentage` — if success percentage >= threshold, return `SUCCESS`; otherwise `FAILURE`.
   - `successCount` — if successes >= `successCount`, return `SUCCESS`; otherwise `FAILURE`.
4. If no policy fields are set, all children must succeed (any failure means `FAILURE`).

The default policy produced by `DefaultParallelStrategy` is `{ successCount: children.length }`, meaning every child must succeed.

---

## Strategy Pattern

Each composite delegates its ordering or policy logic to a strategy object. This separates the structural traversal from the decision-making, and allows you to swap in agent-driven or custom strategies without changing the composite itself.

Three strategy interfaces correspond to the three composite types:

```typescript
interface SelectionStrategy {
  order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]>;
}

interface ExecutionStrategy {
  order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]>;
}

interface ParallelStrategy {
  policy(children: BTreeNode[], context: TreeContext): Promise<ParallelPolicy>;
}
```

### Default Strategies

- **`DefaultSelectionStrategy`** — returns children in their original order.
- **`DefaultExecutionStrategy`** — returns children in their original order.
- **`DefaultParallelStrategy`** — accepts an optional `ParallelPolicy` in its constructor. When none is provided, defaults to all-must-succeed (`{ successCount: children.length }`).

### Agent Strategies

Agent strategies use Claude to make runtime decisions about child ordering or parallel policy. All three accept the same configuration:

```typescript
interface AgentStrategyConfig {
  prompt: string | ((children: BTreeNode[], context: TreeContext) => string);
  model?: 'sonnet' | 'opus' | 'haiku';
  effort?: 'low' | 'medium' | 'high' | 'max';
  childDescriptions?: Record<string, string>;
}
```

- **`AgentSelectionStrategy`** — Claude reorders selector children based on context.
- **`AgentExecutionStrategy`** — Claude reorders sequence children based on context.
- **`AgentParallelStrategy`** — Claude adjusts parallel policy based on context.

All agent strategies use `buildStrategyPrompt`, which includes child descriptions and current blackboard state in the prompt sent to Claude. On agent failure, each strategy falls back to default behavior (original order for selection/execution, all-must-succeed for parallel).

When an agent strategy produces a result, it emits a `strategy:decision` event on the tree's event bus with the strategy name and decision payload.

**Example with agent strategy:**

```typescript
import { TreeBuilder, AgentSelectionStrategy } from 'cartographer';

const tree = new TreeBuilder('smart-selector')
  .selector('pick-best', {
    strategy: new AgentSelectionStrategy({
      prompt: 'Pick the best data source based on current state',
      model: 'haiku',
      effort: 'low',
      childDescriptions: {
        'try-cache': 'Fast but may be stale',
        'try-api': 'Always fresh but slower',
        'use-default': 'Hardcoded fallback value',
      },
    }),
  }, (b) => {
    b.action('try-cache', tryCache);
    b.action('try-api', tryApi);
    b.action('use-default', useDefault);
  })
  .build();
```

### Writing a Custom Strategy

Implement the relevant interface and pass your strategy to the composite config. The example below prioritizes a child whose name matches a blackboard value:

```typescript
import type { SelectionStrategy, BTreeNode, TreeContext } from 'cartographer';

class PriorityStrategy implements SelectionStrategy {
  async order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]> {
    const priority = context.blackboard.get<string>('priority');
    if (priority) {
      const prioritized = children.find(c => c.name === priority);
      if (prioritized) {
        return [prioritized, ...children.filter(c => c !== prioritized)];
      }
    }
    return children;
  }
}
```

Pass the strategy when constructing the composite:

```typescript
const selector = new SelectorNode({
  name: 'priority-selector',
  children: [...],
  strategy: new PriorityStrategy(),
});
```

---

## Where to go next

- [Decorator nodes: inverter, retry, guard, and more](guide-decorators.md)
- [Agent integration and tool use](guide-agent-integration.md)
