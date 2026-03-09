# Strategies API Reference

Strategy interfaces control how composite nodes select, order, and execute their children. Each composite node type accepts a corresponding strategy. Agent-backed strategies use Claude to make runtime decisions.

## Interfaces

### SelectionStrategy

```typescript
import type { SelectionStrategy } from 'cartographer';

interface SelectionStrategy {
  order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]>;
}
```

Used by `SelectorNode`. Returns children in the order they should be tried.

### ExecutionStrategy

```typescript
import type { ExecutionStrategy } from 'cartographer';

interface ExecutionStrategy {
  order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]>;
}
```

Used by `SequenceNode`. Returns children in execution order.

### ParallelStrategy

```typescript
import type { ParallelStrategy } from 'cartographer';

interface ParallelStrategy {
  policy(children: BTreeNode[], context: TreeContext): Promise<ParallelPolicy>;
}
```

Used by `ParallelNode`. Returns the success/failure policy.

### ParallelPolicy

```typescript
import type { ParallelPolicy } from 'cartographer';

interface ParallelPolicy {
  successCount?: number;
  successPercentage?: number;
  failureCount?: number;
}
```

### AgentStrategyConfig

```typescript
import type { AgentStrategyConfig } from 'cartographer';

interface AgentStrategyConfig {
  prompt: string | ((children: BTreeNode[], context: TreeContext) => string);
  model?: 'sonnet' | 'opus' | 'haiku';
  effort?: 'low' | 'medium' | 'high' | 'max';
  childDescriptions?: Record<string, string>;
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prompt` | `string \| function` | Yes | — | Base prompt for Claude. Function receives children and context. |
| `model` | `'sonnet' \| 'opus' \| 'haiku'` | No | `'sonnet'` | Claude model |
| `effort` | `'low' \| 'medium' \| 'high' \| 'max'` | No | `'low'` | Effort level |
| `childDescriptions` | `Record<string, string>` | No | — | Maps child name to human description |

## Default Strategies

### DefaultSelectionStrategy

```typescript
import { DefaultSelectionStrategy } from 'cartographer';
```

Constructor: `new DefaultSelectionStrategy()`

Returns children in original order (pass-through).

### DefaultExecutionStrategy

```typescript
import { DefaultExecutionStrategy } from 'cartographer';
```

Constructor: `new DefaultExecutionStrategy()`

Returns children in original order (pass-through).

### DefaultParallelStrategy

```typescript
import { DefaultParallelStrategy } from 'cartographer';
```

Constructor: `new DefaultParallelStrategy(policy?: ParallelPolicy)`

If `policy` is provided, returns it. Otherwise defaults to `{ successCount: children.length }` (all must succeed).

Example:

```typescript
new DefaultParallelStrategy({ successCount: 2 })
new DefaultParallelStrategy({ successPercentage: 75 })
new DefaultParallelStrategy({ failureCount: 1 })
```

## Agent Strategies

All agent strategies use Claude to make decisions. They call `buildStrategyPrompt()` which constructs a prompt including:

- The base prompt from config
- Child names and descriptions (from `childDescriptions`)
- Current blackboard state (serialized as JSON)

On agent failure (SDK error, invalid response), all gracefully fall back to default behavior.

### AgentSelectionStrategy

```typescript
import { AgentSelectionStrategy } from 'cartographer';
```

Constructor: `new AgentSelectionStrategy(config: AgentStrategyConfig)`

Implements `SelectionStrategy`. Asks Claude to reorder children for a selector. Output schema: `{ ordering: string[], reasoning: string }`. Maps returned names back to child nodes. Falls back to original order on failure.

Emits `strategy:decision` with `strategy: 'agent-selection'`.

### AgentExecutionStrategy

```typescript
import { AgentExecutionStrategy } from 'cartographer';
```

Constructor: `new AgentExecutionStrategy(config: AgentStrategyConfig)`

Implements `ExecutionStrategy`. Asks Claude to reorder children for a sequence. Output schema: `{ ordering: string[], reasoning: string }`. Maps returned names back to child nodes. Falls back to original order on failure.

Emits `strategy:decision` with `strategy: 'agent-execution'`.

### AgentParallelStrategy

```typescript
import { AgentParallelStrategy } from 'cartographer';
```

Constructor: `new AgentParallelStrategy(config: AgentStrategyConfig)`

Implements `ParallelStrategy`. Asks Claude to determine parallel policy. Output schema: `{ policy: ParallelPolicy, reasoning: string }`. Falls back to `{ successCount: children.length }` on failure.

Emits `strategy:decision` with `strategy: 'agent-parallel'`.

### Example

```typescript
const strategy = new AgentSelectionStrategy({
  prompt: 'Choose the best data source',
  model: 'haiku',
  effort: 'low',
  childDescriptions: {
    'cache': 'Fast, possibly stale',
    'api': 'Fresh, slower',
  },
});
```
