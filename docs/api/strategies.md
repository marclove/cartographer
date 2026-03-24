# Strategies API Reference

Strategy interfaces control how composite nodes select, order, and execute their children. Each composite node type accepts a corresponding strategy. Agent-backed strategies use Claude to make runtime decisions.

## Interfaces

### SelectionStrategy

```typescript
import type { SelectionStrategy } from "cartographer";

interface SelectionStrategy {
  order(children: BTreeNode[], context: TreeContext): BTreeNode[] | Promise<BTreeNode[]>;
  reset?(): void;
}
```

Used by `SelectorNode`. Returns children in the order they should be tried. The optional `reset()` method is called by the composite during its own `reset()` to clear any cached state.

### ExecutionStrategy

```typescript
import type { ExecutionStrategy } from "cartographer";

interface ExecutionStrategy {
  order(children: BTreeNode[], context: TreeContext): BTreeNode[] | Promise<BTreeNode[]>;
  reset?(): void;
}
```

Used by `SequenceNode`. Returns children in execution order. The optional `reset()` method is called by the composite during its own `reset()` to clear any cached state.

### ParallelStrategy

```typescript
import type { ParallelStrategy } from "cartographer";

interface ParallelStrategy {
  policy(children: BTreeNode[], context: TreeContext): ParallelPolicy | Promise<ParallelPolicy>;
  reset?(): void;
}
```

Used by `ParallelNode`. Returns the success/failure policy. The optional `reset()` method is called by the composite during its own `reset()` to clear any cached state.

### ParallelPolicy

```typescript
import type { ParallelPolicy } from "cartographer";

interface ParallelPolicy {
  successCount?: number;
  successPercentage?: number;
  failureCount?: number;
}
```

### AgentStrategyConfig

```typescript
import type { AgentStrategyConfig } from "cartographer";

interface AgentStrategyConfig {
  prompt: string | ((children: BTreeNode[], context: TreeContext) => string);
  childDescriptions?: Record<string, string>;
  cache?: boolean;
  agent: Agent;
}
```

| Field               | Type                     | Required | Default | Description                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt`            | `string \| function`     | Yes      | —       | Base prompt for the agent. Function receives children and context.                                                                                                                                                                                           |
| `childDescriptions` | `Record<string, string>` | No       | —       | Maps child name to human description                                                                                                                                                                                                                         |
| `cache`             | `boolean`                | No       | `false` | When `true`, the strategy caches its decision across execution cycles. Composites already guarantee intra-cycle stability (strategy is called once per cycle). This flag controls whether the result persists after a cycle completes. Cleared on `reset()`. |
| `agent`             | `Agent`                  | Yes      | —       | The Agent instance used for strategy decisions. Configure model, effort, and other provider options on the agent.                                                                                                                                            |

## Default Strategies

### DefaultSelectionStrategy

```typescript
import { DefaultSelectionStrategy } from "cartographer";
```

Constructor: `new DefaultSelectionStrategy()`

Returns children in original order (pass-through).

### DefaultExecutionStrategy

```typescript
import { DefaultExecutionStrategy } from "cartographer";
```

Constructor: `new DefaultExecutionStrategy()`

Returns children in original order (pass-through).

### DefaultParallelStrategy

```typescript
import { DefaultParallelStrategy } from "cartographer";
```

Constructor: `new DefaultParallelStrategy(policy?: ParallelPolicy)`

If `policy` is provided, returns it. Otherwise defaults to `{ successCount: children.length }` (all must succeed).

Example:

```typescript
new DefaultParallelStrategy({ successCount: 2 });
new DefaultParallelStrategy({ successPercentage: 75 });
new DefaultParallelStrategy({ failureCount: 1 });
```

## Agent Strategies

All agent strategies use Claude to make decisions. They call `buildStrategyPrompt()` which constructs a prompt including:

- The base prompt from config
- Child names and descriptions (from `childDescriptions`)
- Current blackboard state (serialized as JSON)

On agent failure (SDK error, invalid response), all gracefully fall back to default behavior.

All three strategies handle elicitation consistently with `AgentNode`. During each agent call, `context.onElicitation` is passed to `agent.send()`. If no handler exists, elicitation requests are automatically declined and an `agent:elicitation_declined` event is emitted. See the [Elicitation guide](../guide-elicitation.md) for handler levels and precedence.

### AgentSelectionStrategy

```typescript
import { AgentSelectionStrategy } from "cartographer";
```

Constructor: `new AgentSelectionStrategy(config: AgentStrategyConfig)`

Implements `SelectionStrategy`. Asks Claude to reorder children for a selector. Output schema: `{ ordering: string[], reasoning: string }`. Maps returned names back to child nodes. Falls back to original order on failure.

Emits `strategy:decision` with `strategy: 'agent-selection'`, plus the full suite of `agent:*` observability events (see below).

### AgentExecutionStrategy

```typescript
import { AgentExecutionStrategy } from "cartographer";
```

Constructor: `new AgentExecutionStrategy(config: AgentStrategyConfig)`

Implements `ExecutionStrategy`. Asks Claude to reorder children for a sequence. Output schema: `{ ordering: string[], reasoning: string }`. Maps returned names back to child nodes. Falls back to original order on failure.

Emits `strategy:decision` with `strategy: 'agent-execution'`, plus the full suite of `agent:*` observability events (see below).

### AgentParallelStrategy

```typescript
import { AgentParallelStrategy } from "cartographer";
```

Constructor: `new AgentParallelStrategy(config: AgentStrategyConfig)`

Implements `ParallelStrategy`. Asks Claude to determine parallel policy. Output schema: `{ policy: ParallelPolicy, reasoning: string }`. Falls back to `{ successCount: children.length }` on failure.

Emits `strategy:decision` with `strategy: 'agent-parallel'`, plus the full suite of `agent:*` observability events (see below).

### Strategy Observability Events

All three agent strategies emit the same `agent:*` events as `AgentNode` during their agent calls. The event sequence for each strategy invocation is:

1. `agent:prompt` — emitted before calling the agent
2. Intermediate events as the agent streams — `agent:thinking`, `agent:text`, `agent:tool_use`, `agent:stream`, `agent:message`, `agent:init`, `agent:status`, `agent:rate_limit`, `agent:tool_progress`
3. `agent:elicitation_declined` — emitted if an MCP server requests elicitation and no handler is configured
4. `agent:response` (on success) or `agent:error` (on failure) — emitted when the agent returns a result
5. `strategy:decision` — emitted after a successful call with the parsed decision payload

Since strategies don't own a node, all event payloads use `children[0]` as the `node` reference — the same proxy pattern used by `strategy:decision`.

If the agent throws an exception (as opposed to returning an error result), no `agent:response` or `agent:error` is emitted — the strategy silently falls back to default behavior.

### Example

```typescript
const strategyAgent = new ClaudeSDKAgent({
  name: "strategy",
  model: "claude-haiku-4-5",
  effort: "low",
});

const strategy = new AgentSelectionStrategy({
  prompt: "Choose the best data source",
  agent: strategyAgent,
  childDescriptions: {
    cache: "Fast, possibly stale",
    api: "Fresh, slower",
  },
});
```

## Helper Functions

### wrapElicitation

```typescript
import { wrapElicitation } from "cartographer";

function wrapElicitation(
  handler: OnElicitation | undefined,
  node: BTreeNode,
  events: TypedEventEmitter<TreeEvents>,
): OnElicitation;
```

Wraps an optional elicitation handler so callers always receive a function. If `handler` is defined, delegates to it. Otherwise emits `agent:elicitation_declined` and returns `{ action: 'decline' }`. Used internally by `AgentNode` and all three agent strategies; exported for custom agent and strategy implementations.

### buildStrategyPrompt

```typescript
import { buildStrategyPrompt } from "cartographer";

function buildStrategyPrompt(config: AgentStrategyConfig, children: BTreeNode[], context: TreeContext): string;
```

Builds the full prompt string that agent strategies send to the agent. Combines the base prompt with child names/descriptions and a JSON snapshot of the current blackboard state. Used internally by the three agent strategies; exported for custom strategy implementations.
