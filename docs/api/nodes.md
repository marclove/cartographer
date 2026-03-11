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

Leaf node that invokes the Claude Agent SDK. Every call is an agentic SDK invocation. SDK options are passed directly via the `options` field, giving you access to the full range of Agent SDK capabilities.

### Constructor

```typescript
new AgentNode(config: AgentNodeConfig)
```

### AgentNodeConfig

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | Yes | -- | Node name |
| `prompt` | `string \| ((context: TreeContext) => string)` | Yes | -- | Prompt sent to Claude. Can be a static string or a function that builds the prompt from context. |
| `mapResult` | `(output: unknown, context: TreeContext) => NodeStatus` | No | -- | Maps the agent output to a `NodeStatus`. When omitted, any successful response returns `SUCCESS`. |
| `blackboardNamespace` | `string` | No | -- | When set, the auto-attached blackboard MCP server operates on a scoped namespace instead of the full blackboard. |
| `cache` | `boolean` | No | `false` | When `true`, the node calls Claude once and returns the cached status on subsequent ticks. Cleared on `reset()`. |
| `options` | `Partial<Options>` | No | -- | Agent SDK options passed directly to the SDK. Includes `model`, `effort`, `outputFormat`, `allowedTools`, `mcpServers`, `systemPrompt`, `maxTurns`, `maxBudgetUsd`, `permissionMode`, and [many more](https://github.com/anthropics/claude-agent-sdk). |

### Behavior

- Every call is an agentic SDK invocation. All SDK options are available via the `options` field.
- A blackboard MCP server is automatically attached, exposing three tools to the agent: `blackboard_read`, `blackboard_write`, and `blackboard_keys`.
- On success, the result is written to the blackboard at key `{name}:output`.
- When `options.outputFormat` is provided, the SDK validates the response against the schema. If `mapResult` is provided, its return value determines the node status.
- Custom `options.mcpServers` and `options.allowedTools` are merged with the blackboard server config.
- If the `outputFormat.schema` contains a `$schema` meta-property (as produced by `z.toJSONSchema()`), it is automatically stripped before passing to the SDK.
- Emits the full set of agent observability events: `agent:prompt`, `agent:thinking`, `agent:text`, `agent:tool_use`, `agent:response`, `agent:error`, `agent:stream`, `agent:message`, `agent:tool_progress`, `agent:init`, `agent:status`, and `agent:rate_limit`. See [TreeEvents](core.md#treeevents-interface) for payload details.

### Example

```typescript
import { z } from 'zod/v4';
import { AgentNode } from 'cartographer';

const classifier = new AgentNode({
  name: 'classify',
  prompt: 'Classify the following text.',
  options: {
    model: 'claude-haiku-4-5-20251001',
    outputFormat: {
      type: 'json_schema',
      schema: z.toJSONSchema(z.object({ label: z.string() })) as any,
    },
  },
});

const coder = new AgentNode({
  name: 'implement-feature',
  prompt: (ctx) => `Implement: ${ctx.blackboard.get<string>('task')}`,
  options: {
    model: 'claude-sonnet-4-6',
    allowedTools: ['Read', 'Edit', 'Bash'],
    permissionMode: 'acceptEdits',
    maxTurns: 20,
  },
});
```
