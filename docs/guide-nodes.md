# Leaf Nodes

Leaf nodes sit at the edges of a behavior tree. They do the actual work -- checking conditions, performing actions, or delegating to an AI agent. This guide covers all three built-in leaf node types and explains how to create custom nodes by extending `BaseNode`.

---

## ActionNode

An action node runs a user-supplied function and returns its status directly.

### Config

```typescript
interface ActionNodeConfig {
  name: string;
  action: (context: TreeContext) => Promise<NodeStatus> | NodeStatus;
}
```

### Behavior

- The `action` function can be synchronous or asynchronous. Return `NodeStatus` directly or wrap it in a `Promise`.
- Access the shared blackboard via `context.blackboard`.
- Valid return values: `SUCCESS`, `FAILURE`, or `RUNNING`.

### Example

```typescript
import { ActionNode, NodeStatus } from 'cartographer';

const fetchData = new ActionNode({
  name: 'fetch-data',
  action: async (ctx) => {
    try {
      const response = await fetch(ctx.blackboard.get<string>('apiUrl')!);
      ctx.blackboard.set('data', await response.json());
      return NodeStatus.SUCCESS;
    } catch {
      return NodeStatus.FAILURE;
    }
  },
});
```

Typical uses: calling an API, writing computed values to the blackboard, performing side effects, delegating to external systems.

---

## ConditionNode

A condition node evaluates a predicate and maps the result to a node status.

### Config

```typescript
interface ConditionNodeConfig {
  name: string;
  condition: (context: TreeContext) => Promise<boolean> | boolean;
}
```

### Behavior

- The `condition` function returns a boolean (or `Promise<boolean>`).
- `true` maps to `SUCCESS`, `false` maps to `FAILURE`.
- A condition node never returns `RUNNING`.

### Example

```typescript
import { ConditionNode } from 'cartographer';

const hasApiKey = new ConditionNode({
  name: 'has-api-key',
  condition: (ctx) => ctx.blackboard.has('apiKey'),
});
```

Typical uses: checking blackboard state, evaluating environment conditions, gating execution behind feature flags.

---

## AgentNode

`AgentNode` integrates Claude via the Anthropic Agent SDK. Every call is an agentic SDK invocation. Provide an `outputSchema` to get structured, schema-validated output.

### Behavior

Every AgentNode automatically:

- Attaches a blackboard MCP server so the agent can read and write shared state.
- Writes the agent's result to `{name}:output` on the blackboard.

All options -- `allowedTools`, `maxTurns`, `systemPrompt`, `mcpServers`, `permissionMode`, `maxBudgetUsd` -- are available regardless of whether `outputSchema` is set.

### Example

```typescript
import { AgentNode } from 'cartographer';

const classifier = new AgentNode({
  name: 'classify-intent',
  prompt: (ctx) => `Classify this text: ${ctx.blackboard.get<string>('input')}`,
  model: 'haiku',
  effort: 'low',
});
```

For the full `AgentNodeConfig` reference and advanced patterns, see [Agent Integration](guide-agent-integration.md).

---

## BaseNode (Custom Nodes)

All built-in nodes extend `BaseNode`, which implements the template method pattern. You can extend it to create your own node types.

### Lifecycle

`tick()` wraps your `execute()` implementation with event emission and error handling:

```
tick(context)
  emit('node:enter')
  try {
    status = execute(context)   // abstract -- subclasses implement this
    emit('node:exit', { status, durationMs })
  } catch (error) {
    emit('node:error', { error })
    emit('node:exit', { status: FAILURE, durationMs })
    return FAILURE
  }
```

If `execute()` throws, the node catches the error, emits both `node:error` and `node:exit` events, and returns `FAILURE`. You never need to handle errors in `tick()` yourself.

### Properties

- `id` -- auto-generated UUID, unique per node instance.
- `name` -- the string passed to the constructor.

### Creating a custom node

Extend `BaseNode` and implement the abstract `execute()` method:

```typescript
import { BaseNode, NodeStatus } from 'cartographer';
import type { TreeContext } from 'cartographer';

class LogNode extends BaseNode {
  private message: string;

  constructor(name: string, message: string) {
    super(name);
    this.message = message;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    console.log(this.message, context.blackboard.keys());
    return NodeStatus.SUCCESS;
  }
}
```

### Optional overrides

- `reset()` -- override if your node maintains state between ticks that should be cleared when the tree resets.
- `abort()` -- override if your node starts work that should be cancelled when the tree is interrupted (e.g., pending network requests, timers).

Both methods are no-ops by default.

---

## Where to go next

- [Building Trees](guide-building-trees.md) -- `TreeBuilder`, nesting, and construction patterns.
- [Composite Nodes](guide-composites.md) -- selector, sequence, and parallel execution.
- [Decorator Nodes](guide-decorators.md) -- inverter, retry, guard, timeout, and more.
- [Agent Integration](guide-agent-integration.md) -- full `AgentNode` reference and advanced patterns.
