# Node Classes API Reference

All node classes are exported from the `cartographer` package.

---

## BaseNode

```typescript
import { BaseNode } from 'cartographer';
```

Abstract class implementing `BTreeNode`. Base for all built-in nodes.

### Constructor

```typescript
new BaseNode(name: string)
```

Called via `super(name)` in subclasses.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` (readonly) | Auto-generated UUID |
| `name` | `string` (readonly) | Human-readable name, set via constructor |

### Public Methods

#### `tick(context: TreeContext): Promise<NodeStatus>`

Template method that wraps `execute()`:

1. Emits `node:enter` with `{ node, context }`.
2. Calls the protected `execute(context)`.
3. Emits `node:exit` with `{ node, status, context, durationMs }`.
4. On error: emits `node:error` with `{ node, error, context }`, emits `node:exit` with `FAILURE` status, and returns `FAILURE`.

#### `reset(): void`

No-op by default. Override in subclasses that hold state between ticks.

#### `abort(): void`

No-op by default. Override in subclasses that have in-progress work to cancel.

### Protected Abstract Method

#### `execute(context: TreeContext): Promise<NodeStatus>`

Subclasses implement this to define tick behavior.

### Example

```typescript
import { BaseNode, NodeStatus, TreeContext } from 'cartographer';

class MyNode extends BaseNode {
  constructor() {
    super('my-node');
  }

  protected async execute(ctx: TreeContext): Promise<NodeStatus> {
    return NodeStatus.SUCCESS;
  }
}
```

---

## ActionNode

```typescript
import { ActionNode } from 'cartographer';
```

Leaf node that delegates execution to a user-supplied function.

### Constructor

```typescript
new ActionNode(config: ActionNodeConfig)
```

### ActionNodeConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Node name |
| `action` | `(context: TreeContext) => Promise<NodeStatus> \| NodeStatus` | Yes | Function invoked on each tick. Return value becomes the node status. |

### Example

```typescript
import { ActionNode, NodeStatus } from 'cartographer';

const node = new ActionNode({
  name: 'greet',
  action: (ctx) => {
    ctx.blackboard.set('greeting', 'hello');
    return NodeStatus.SUCCESS;
  },
});
```

---

## ConditionNode

```typescript
import { ConditionNode } from 'cartographer';
```

Leaf node that evaluates a boolean predicate. Returns `SUCCESS` when the predicate is `true`, `FAILURE` when `false`. Never returns `RUNNING`.

### Constructor

```typescript
new ConditionNode(config: ConditionNodeConfig)
```

### ConditionNodeConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Node name |
| `condition` | `(context: TreeContext) => Promise<boolean> \| boolean` | Yes | Predicate function. `true` maps to `SUCCESS`, `false` maps to `FAILURE`. |

### Example

```typescript
import { ConditionNode } from 'cartographer';

const node = new ConditionNode({
  name: 'is-ready',
  condition: (ctx) => ctx.blackboard.get<boolean>('ready') === true,
});
```

---

## AgentNode

```typescript
import { AgentNode } from 'cartographer';
```

Leaf node that invokes the Claude Agent SDK. Every call is an agentic SDK invocation. Provide an `outputSchema` to get structured, schema-validated output.

### Constructor

```typescript
new AgentNode(config: AgentNodeConfig)
```

### AgentNodeConfig

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | Yes | -- | Node name |
| `prompt` | `string \| ((context: TreeContext) => string)` | Yes | -- | Prompt sent to Claude. Can be a static string or a function that builds the prompt from context. |
| `outputSchema` | `z.ZodType` | No | -- | Zod schema for the expected output; converted to JSON Schema internally. When set, the agent returns structured, validated output. |
| `mapResult` | `(output: unknown, context: TreeContext) => NodeStatus` | No | -- | Maps the parsed structured output to a `NodeStatus`. Only applicable when `outputSchema` is set. When omitted, any successful response returns `SUCCESS`. |
| `allowedTools` | `string[]` | No | -- | Tool name patterns the agent is allowed to call (merged with the auto-attached blackboard tools). |
| `permissionMode` | `'acceptEdits' \| 'bypassPermissions' \| 'default'` | No | `'default'` | Controls how tool-use permissions are enforced. |
| `maxTurns` | `number` | No | -- | Maximum number of conversation turns. |
| `maxBudgetUsd` | `number` | No | -- | Spending cap in USD. |
| `systemPrompt` | `string` | No | -- | System prompt prepended to the conversation. |
| `mcpServers` | `Record<string, unknown>` | No | -- | Additional MCP servers merged with the auto-attached blackboard server. |
| `model` | `'sonnet' \| 'opus' \| 'haiku'` | No | -- | Claude model to use. |
| `effort` | `'low' \| 'medium' \| 'high' \| 'max'` | No | -- | Effort level passed to the SDK. |
| `blackboardNamespace` | `string` | No | -- | When set, the auto-attached blackboard MCP server operates on a scoped namespace instead of the full blackboard. |
| `cache` | `boolean` | No | `false` | When `true`, the node calls Claude once and returns the cached status on subsequent ticks. Cleared on `reset()`. |

### Behavior

- Every call is an agentic SDK invocation. All options are available regardless of whether `outputSchema` is set.
- A blackboard MCP server is automatically attached, exposing three tools to the agent: `blackboard_read`, `blackboard_write`, and `blackboard_keys`.
- On success, the result is written to the blackboard at key `{name}:output`.
- If `outputSchema` is provided, it is converted to JSON Schema via `zod` and passed as the output format. If `mapResult` is provided, its return value determines the node status.
- Custom `mcpServers` and `allowedTools` are merged with the blackboard server config.
- Emits the full set of agent observability events: `agent:prompt`, `agent:thinking`, `agent:text`, `agent:tool_use`, `agent:response`, `agent:error`, `agent:stream`, `agent:message`, `agent:tool_progress`, `agent:init`, `agent:status`, and `agent:rate_limit`. See [TreeEvents](core.md#treeevents-interface) for payload details.

### Example

```typescript
import { z } from 'zod';
import { AgentNode } from 'cartographer';

const classifier = new AgentNode({
  name: 'classify',
  prompt: 'Classify the following text.',
  model: 'haiku',
  outputSchema: z.object({ label: z.string() }),
});

const coder = new AgentNode({
  name: 'implement-feature',
  prompt: (ctx) => `Implement: ${ctx.blackboard.get<string>('task')}`,
  model: 'sonnet',
  allowedTools: ['Read', 'Edit', 'Bash'],
  permissionMode: 'acceptEdits',
  maxTurns: 20,
});
```
