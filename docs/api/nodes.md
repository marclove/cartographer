# Node Classes API Reference

All node classes are exported from the `cartographer` package.

---

## BaseNode

```typescript
import { BaseNode } from "cartographer";
```

Abstract class implementing `BTreeNode`. Base for all built-in nodes.

### Constructor

```typescript
new BaseNode(name: string, id?: string)
```

Called via `super(name)` or `super(name, id)` in subclasses. When `id` is omitted, a UUID v4 is generated automatically. All built-in node configs (`ActionNodeConfig`, `ConditionNodeConfig`, `AgentNodeConfig`, composite configs, decorator configs) expose an optional `id` field that flows through to this parameter.

### Properties

| Property | Type                | Description                                                                |
| -------- | ------------------- | -------------------------------------------------------------------------- |
| `id`     | `string` (readonly) | Unique identifier — auto-generated UUID unless a custom `id` was provided. |
| `name`   | `string` (readonly) | Human-readable name, set via constructor.                                  |

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

#### `interrupt(): void`

Default implementation clears unsettled `_inflightState` and calls `interrupt()` on all children. Unlike `abort()`, composites' cycle state (`completedMap`, `committedOrder`) is preserved, and no `reset()` is required afterward. Override in subclasses that need additional cleanup beyond clearing inflight state.

#### `setContextOverrides(overrides: Partial<TreeContext>): void`

Replace the node's context overrides. These overrides are shallow-merged onto the `TreeContext` at the start of each `tick()`, so all descendants of this node see the overridden values. `events` and `blackboard` are pinned and cannot be overridden.

#### `mergeContextOverrides(overrides: Partial<TreeContext>): void`

Merge additional overrides into any existing context overrides. Useful when multiple sources each contribute overrides (e.g., a tree-level `onElicitation` plus a subtree-level override).

### Context Layering

When a node has context overrides set, `tick()` creates an effective context by shallow-merging the overrides onto the incoming `TreeContext` before executing. Two fields are pinned and never overridden: `events` (ensures all events reach the tree-level emitter) and `blackboard` (preserves the shared state store). The closest override to a node wins — a child's override takes precedence over a parent's.

### Protected Abstract Method

#### `execute(context: TreeContext): Promise<NodeStatus>`

Subclasses implement this to define tick behavior.

### Example

```typescript
import { BaseNode, NodeStatus, TreeContext } from "cartographer";

class MyNode extends BaseNode {
  constructor() {
    super("my-node");
  }

  protected async execute(ctx: TreeContext): Promise<NodeStatus> {
    return NodeStatus.SUCCESS;
  }
}
```

---

## ActionNode

```typescript
import { ActionNode } from "cartographer";
```

Leaf node that delegates execution to a user-supplied function.

### Constructor

```typescript
new ActionNode(config: ActionNodeConfig)
```

### ActionNodeConfig

| Field    | Type                                                          | Required | Description                                                          |
| -------- | ------------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| `id`     | `string`                                                      | No       | Custom node identifier. Auto-generated UUID when omitted.            |
| `name`   | `string`                                                      | Yes      | Node name                                                            |
| `action` | `(context: TreeContext) => Promise<NodeStatus> \| NodeStatus` | Yes      | Function invoked on each tick. Return value becomes the node status. |

### Example

```typescript
import { ActionNode, NodeStatus } from "cartographer";

const node = new ActionNode({
  name: "greet",
  action: (ctx) => {
    ctx.blackboard.set("greeting", "hello");
    return NodeStatus.SUCCESS;
  },
});
```

---

## ConditionNode

```typescript
import { ConditionNode } from "cartographer";
```

Leaf node that evaluates a boolean predicate. Returns `SUCCESS` when the predicate is `true`, `FAILURE` when `false`. Never returns `RUNNING`.

### Constructor

```typescript
new ConditionNode(config: ConditionNodeConfig)
```

### ConditionNodeConfig

| Field       | Type                                                    | Required | Description                                                              |
| ----------- | ------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `id`        | `string`                                                | No       | Custom node identifier. Auto-generated UUID when omitted.                |
| `name`      | `string`                                                | Yes      | Node name                                                                |
| `condition` | `(context: TreeContext) => Promise<boolean> \| boolean` | Yes      | Predicate function. `true` maps to `SUCCESS`, `false` maps to `FAILURE`. |

### Example

```typescript
import { ConditionNode } from "cartographer";

const node = new ConditionNode({
  name: "is-ready",
  condition: (ctx) => ctx.blackboard.get<boolean>("ready") === true,
});
```

---

## AgentNode

```typescript
import { AgentNode } from "cartographer";
```

Leaf node that invokes the Claude Agent SDK. Every call is an agentic SDK invocation. SDK options are passed directly via the `options` field, giving you access to the full range of Agent SDK capabilities.

### Constructor

```typescript
new AgentNode(config: AgentNodeConfig)
```

### AgentNodeConfig

| Field                 | Type                                                    | Required | Default | Description                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                  | `string`                                                | No       | --      | Custom node identifier. Auto-generated UUID when omitted.                                                                                                                                                                                                                |
| `name`                | `string`                                                | Yes      | --      | Node name                                                                                                                                                                                                                                                                |
| `prompt`              | `string \| ((context: TreeContext) => string)`          | Yes      | --      | Prompt sent to Claude. Can be a static string or a function that builds the prompt from context.                                                                                                                                                                         |
| `mapResult`           | `(output: unknown, context: TreeContext) => NodeStatus` | No       | --      | Maps the agent output to a `NodeStatus`. When omitted, any successful response returns `SUCCESS`.                                                                                                                                                                        |
| `blackboardNamespace` | `string`                                                | No       | --      | When set, the auto-attached blackboard MCP server operates on a scoped namespace instead of the full blackboard.                                                                                                                                                         |
| `cache`               | `boolean`                                               | No       | `false` | When `true`, the node calls Claude once and returns the cached status on subsequent ticks. Cleared on `reset()`.                                                                                                                                                         |
| `options`             | `Partial<Options>`                                      | No       | --      | Agent SDK options passed directly to the SDK. Includes `model`, `effort`, `outputFormat`, `allowedTools`, `mcpServers`, `systemPrompt`, `maxTurns`, `maxBudgetUsd`, `permissionMode`, and [many more](https://platform.claude.com/docs/en/agent-sdk/typescript#options). |

### Behavior

- Every call is an agentic SDK invocation. All SDK options are available via the `options` field.
- A blackboard MCP server is automatically attached, exposing three tools to the agent: `blackboard_read`, `blackboard_write`, and `blackboard_keys`.
- On success, the result is written to the blackboard at key `{name}:output`.
- When `options.outputFormat` is provided, the SDK validates the response against the schema. If `mapResult` is provided, its return value determines the node status.
- Custom `options.mcpServers` and `options.allowedTools` are merged with the blackboard server config.
- If the `outputFormat.schema` contains a `$schema` meta-property (as produced by `z.toJSONSchema()`), it is automatically stripped before passing to the SDK.
- Emits the full set of agent observability events: `agent:prompt`, `agent:thinking`, `agent:text`, `agent:tool_use`, `agent:response`, `agent:error`, `agent:stream`, `agent:message`, `agent:tool_progress`, `agent:init`, `agent:status`, and `agent:rate_limit`. See [TreeEvents](core.md#treeevents-interface) for payload details.

### Elicitation Handling

`AgentNode` always provides an `onElicitation` callback to the SDK. The handler is resolved with the following precedence:

1. **Node-level** — `options.onElicitation` on the `AgentNodeConfig`.
2. **Context-level** — `context.onElicitation`, inherited through context layering from a parent node or tree-level config.
3. **Auto-decline** — If no handler is found at any level, the request is declined and an `agent:elicitation_declined` event is emitted with the request payload.

See [Elicitation](../guide-agent-integration.md#elicitation) for usage examples.

### Example

```typescript
import { z } from "zod/v4";
import { AgentNode } from "cartographer";

const classifier = new AgentNode({
  name: "classify",
  prompt: "Classify the following text.",
  options: {
    model: "claude-haiku-4-5-20251001",
    outputFormat: {
      type: "json_schema",
      schema: z.toJSONSchema(z.object({ label: z.string() })) as any,
    },
  },
});

const coder = new AgentNode({
  name: "implement-feature",
  prompt: (ctx) => `Implement: ${ctx.blackboard.get<string>("task")}`,
  options: {
    model: "claude-sonnet-4-6",
    allowedTools: ["Read", "Edit", "Bash"],
    permissionMode: "acceptEdits",
    maxTurns: 20,
  },
});
```

---

## ReceiveNode

```typescript
import { receive, ReceiveNode } from "cartographer";
```

Synchronous, non-reactive leaf node that receives and consumes inbound commands from the blackboard in the [application server](../guide-app-server.md).

### Factory

```typescript
const node = receive(name: string, options?: ReceiveOptions);
```

### ReceiveOptions

| Field        | Type                                                 | Required | Description                                                |
| ------------ | ---------------------------------------------------- | -------- | ---------------------------------------------------------- |
| `mapPayload` | `(payload: unknown, blackboard: Blackboard) => void` | No       | Callback to extract data from the consumed command payload. |

### Behavior

- Checks `commands:<name>` on the blackboard. If present, deletes the key and returns `SUCCESS`. If absent, returns `FAILURE`.
- Never returns `RUNNING` (synchronous, no inflight state).
- Non-reactive: cached in composite `completedMap`, preventing consume-on-read double-execution.

---

## EmitToClientNode

```typescript
import { emitToClient, EmitToClientNode } from "cartographer";
```

Action node that sends structured data to connected clients via dual write (blackboard + event).

### Factory

```typescript
const node = emitToClient(name: string, dataFn: (ctx: TreeContext) => unknown);
```

### Behavior

- Writes result of `dataFn(ctx)` to `clientEvents:<name>` on the blackboard.
- Emits a `client:event` event with `{ name, data }`.
- Returns `SUCCESS` (uses the standard inflight pattern since it extends `ActionNode`).

---

## isReactiveNode

```typescript
import { isReactiveNode } from "cartographer";
```

Helper function that determines whether a node is "reactive" — i.e., should be re-evaluated on every tick rather than cached within a composite's execution cycle.

### Signature

```typescript
function isReactiveNode(node: BTreeNode): boolean;
```

### Reactivity Rules

A node is reactive if:

- It is a `ConditionNode` (conditions are always reactive).
- It is a `GuardNode` (guards re-evaluate their condition on every tick).
- It is a single-child decorator whose child is reactive (reactivity inherits through decorator chains).

Everything else (actions, agents, composites) is non-reactive. Non-reactive nodes have their terminal results cached within a composite's execution cycle.

### Example

```typescript
import { isReactiveNode, ConditionNode, ActionNode, InverterNode } from "cartographer";

const cond = new ConditionNode({ name: "check", condition: () => true });
isReactiveNode(cond); // true

const action = new ActionNode({ name: "work", action: () => NodeStatus.SUCCESS });
isReactiveNode(action); // false

// Inverter wrapping a condition inherits reactivity
const inv = new InverterNode({ name: "not-check", child: cond });
isReactiveNode(inv); // true
```
