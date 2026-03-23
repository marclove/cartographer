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

1. If no child order is committed for the current cycle, obtains it from `strategy.order()` (default: original insertion order) and commits it.
2. Iterates children from the beginning on every tick.
3. Reactive children (conditions, guards) are always re-ticked. Non-reactive children that already returned a terminal status in this cycle use the cached result.
4. First `SUCCESS` — selector returns `SUCCESS` and clears the cycle (cached results, committed order).
5. First `RUNNING` — selector returns `RUNNING` (cycle preserved).
6. All `FAILURE` — selector returns `FAILURE` and clears the cycle.
7. **Preemption**: If a higher-priority reactive child succeeds while a lower-priority child is RUNNING, the lower-priority child is aborted and the selector returns `SUCCESS`.

The strategy is consulted once per execution cycle (committed and reused across ticks within the cycle). The committed order is cleared on terminal results or `reset()`.

### Example

```typescript
import { SelectorNode, ActionNode, NodeStatus } from "cartographer";

const selector = new SelectorNode({
  name: "try-sources",
  children: [
    new ActionNode({ name: "try-cache", action: tryCache }),
    new ActionNode({ name: "try-api", action: tryApi }),
    new ActionNode({ name: "use-default", action: useDefault }),
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

1. If no child order is committed for the current cycle, obtains it from `strategy.order()` (default: original insertion order) and commits it.
2. Re-evaluates from child 0 on every tick.
3. Reactive children (conditions, guards) are always re-ticked. Non-reactive children that already returned a terminal status in this cycle use the cached result.
4. First child returning `FAILURE` — sequence returns `FAILURE` and clears the cycle (cached results, committed order).
5. First child returning `RUNNING` — sequence returns `RUNNING` (cycle preserved).
6. All children return `SUCCESS` — sequence returns `SUCCESS` and clears the cycle.

The strategy is consulted once per execution cycle (committed and reused across ticks within the cycle). The committed order is cleared on terminal results or `reset()`.

---

## ParallelNode

Ticks all children concurrently, with early policy evaluation that can short-circuit before all children complete.

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

1. Gets policy from `strategy.policy()` on the first tick of a cycle; commits it for the cycle.
2. Ticks all children concurrently. Reactive children are always re-ticked; non-reactive children use cached terminal results.
3. **Early termination** — policies are evaluated on every tick with partial results:
   - `failureCount` — if failures >= threshold, return `FAILURE` immediately (even with RUNNING children).
   - `successCount` — if successes >= threshold, return `SUCCESS`; if `successes + running < threshold`, return `FAILURE`. Otherwise `RUNNING`.
   - `successPercentage` — requires all children to complete (no early exit). Returns `SUCCESS` if percentage >= threshold, otherwise `FAILURE`.
   - Default (no policy fields): any failure returns `FAILURE`; any RUNNING returns `RUNNING`; all SUCCESS returns `SUCCESS`.

The default policy produced by `DefaultParallelStrategy` is `{ successCount: children.length }`, meaning every child must succeed.

---

## Strategy Pattern

Each composite delegates its ordering or policy logic to a strategy object. This separates the structural traversal from the decision-making, and allows you to swap in agent-driven or custom strategies without changing the composite itself.

Three strategy interfaces correspond to the three composite types:

```typescript
interface SelectionStrategy {
  order(children: BTreeNode[], context: TreeContext): BTreeNode[] | Promise<BTreeNode[]>;
  reset?(): void;
}

interface ExecutionStrategy {
  order(children: BTreeNode[], context: TreeContext): BTreeNode[] | Promise<BTreeNode[]>;
  reset?(): void;
}

interface ParallelStrategy {
  policy(children: BTreeNode[], context: TreeContext): ParallelPolicy | Promise<ParallelPolicy>;
  reset?(): void;
}
```

The optional `reset()` method is called by composites during their own `reset()`. Strategies that hold cached state (such as agent strategies with `cache: true`) use this to clear their caches when the tree resets.

### Default Strategies

- **`DefaultSelectionStrategy`** — returns children in their original order.
- **`DefaultExecutionStrategy`** — returns children in their original order.
- **`DefaultParallelStrategy`** — accepts an optional `ParallelPolicy` in its constructor. When none is provided, defaults to all-must-succeed (`{ successCount: children.length }`).

### Agent Strategies

Agent strategies use Claude to make runtime decisions about child ordering or parallel policy. All three accept the same configuration:

```typescript
import type { Options } from "@anthropic-ai/claude-agent-sdk";

interface AgentStrategyConfig {
  prompt: string | ((children: BTreeNode[], context: TreeContext) => string);
  childDescriptions?: Record<string, string>;
  cache?: boolean;
  options?: Partial<Options>;
}
```

The `options` field accepts any property from the [Agent SDK's `Options` type](https://platform.claude.com/docs/en/agent-sdk/typescript#options). Agent strategies default to `model: 'sonnet'` and `effort: 'low'` when not specified.

- **`AgentSelectionStrategy`** — Claude reorders selector children based on context.
- **`AgentExecutionStrategy`** — Claude reorders sequence children based on context.
- **`AgentParallelStrategy`** — Claude adjusts parallel policy based on context.

All agent strategies use `buildStrategyPrompt`, which includes child descriptions and current blackboard state in the prompt sent to Claude. On agent failure, each strategy falls back to default behavior (original order for selection/execution, all-must-succeed for parallel).

Agent strategies emit `agent:*` observability events throughout their SDK calls — `agent:prompt` before calling Claude, intermediate events (`agent:thinking`, `agent:text`, etc.) as the SDK streams, and `agent:response` or `agent:error` when the result arrives. After a successful call, a `strategy:decision` event is emitted with the strategy name and decision payload. See the [Strategies API reference](api/strategies.md#strategy-observability-events) for the full event sequence.

#### Order Commitment vs Strategy Caching

Composites handle intra-cycle order stability automatically: the strategy is consulted once when a new execution cycle begins, and the returned order is committed until the cycle completes (SUCCESS/FAILURE) or the node is reset. This means the strategy is never called redundantly while a child is RUNNING.

When `cache: true` is set on the config, the strategy also caches its decision _across_ execution cycles. After a cycle completes and a new one starts, the cached result is reused without calling Claude again. The cache is cleared when `reset()` is called on the composite.

```typescript
const strategy = new AgentExecutionStrategy({
  prompt: "Order these deployment steps for the current environment",
  options: { model: "claude-haiku-4-5" },
  cache: true, // Reuse across cycles; cleared on reset()
});
```

**Example with agent strategy:**

```typescript
import { TreeBuilder, AgentSelectionStrategy } from "cartographer";

const tree = new TreeBuilder("smart-selector")
  .selector(
    "pick-best",
    {
      strategy: new AgentSelectionStrategy({
        prompt: "Pick the best data source based on current state",
        options: {
          model: "claude-haiku-4-5",
          effort: "low",
        },
        childDescriptions: {
          "try-cache": "Fast but may be stale",
          "try-api": "Always fresh but slower",
          "use-default": "Hardcoded fallback value",
        },
      }),
    },
    (b) => {
      b.action("try-cache", tryCache);
      b.action("try-api", tryApi);
      b.action("use-default", useDefault);
    },
  )
  .build();
```

### Writing a Custom Strategy

Implement the relevant interface and pass your strategy to the composite config. The example below prioritizes a child whose name matches a blackboard value:

```typescript
import type { SelectionStrategy, BTreeNode, TreeContext } from "cartographer";

class PriorityStrategy implements SelectionStrategy {
  async order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]> {
    const priority = context.blackboard.get<string>("priority");
    if (priority) {
      const prioritized = children.find((c) => c.name === priority);
      if (prioritized) {
        return [prioritized, ...children.filter((c) => c !== prioritized)];
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
