# Leaf Nodes

Leaf nodes sit at the edges of a behavior tree. They do the actual work -- checking conditions, performing actions, or delegating to an AI agent. This guide covers the built-in leaf node types (including the application server nodes `receive` and `emitToClient`) and explains how to create custom nodes by extending `BaseNode`.

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
- Actions use the **inflight pattern**: on the first tick the action function is invoked and the node returns `RUNNING` immediately. On subsequent ticks the node polls for the result without re-invoking the function. This keeps ticks non-blocking so composites can re-evaluate reactive children while the action runs in the background.

### Example

```typescript
import { ActionNode, NodeStatus } from "cartographer";

const fetchData = new ActionNode({
  name: "fetch-data",
  action: async (ctx) => {
    try {
      const response = await fetch(ctx.blackboard.get<string>("apiUrl")!);
      ctx.blackboard.set("data", await response.json());
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
import { ConditionNode } from "cartographer";

const hasApiKey = new ConditionNode({
  name: "has-api-key",
  condition: (ctx) => ctx.blackboard.has("apiKey"),
});
```

Typical uses: checking blackboard state, evaluating environment conditions, gating execution behind feature flags.

---

## AgentNode

`AgentNode` integrates AI agents into the behavior tree. Each AgentNode references an `Agent` instance that handles provider-specific concerns (model selection, tools, MCP servers, structured output, budget caps). The node focuses on BT integration: prompt resolution, event emission, blackboard I/O, `mapResult`, and caching.

### Behavior

Every AgentNode automatically:

- Attaches a blackboard MCP server so the agent can read and write shared state.
- Writes the agent's result to `{name}:output` on the blackboard.
- Uses the **inflight pattern**: the agent call launches on the first tick, the node returns `RUNNING`, and subsequent ticks poll for completion without re-invoking the agent. When `cache: true`, the cached result is returned immediately without any inflight overhead.

### Example

```typescript
import { AgentNode, ClaudeSDKAgent } from "cartographer";

const classifyAgent = new ClaudeSDKAgent({
  name: "classify-intent",
  model: "claude-haiku-4-5",
  effort: "low",
});

const classifier = new AgentNode({
  name: "classify-intent",
  agent: classifyAgent,
  prompt: (ctx) => `Classify this text: ${ctx.blackboard.get<string>("input")}`,
});
```

For the full `AgentNodeConfig` reference and advanced patterns, see [Agent Integration](guide-agent-integration.md).

---

## ReceiveNode

A synchronous, non-reactive node that receives and consumes an inbound command from the blackboard. Designed for the [application server](guide-app-server.md) where user commands are delivered as blackboard entries.

### Factory

```typescript
import { receive } from "cartographer";

const node = receive("approve");
```

### Behavior

- Checks for `commands:<name>` on the blackboard.
- If present: deletes the key (consume-on-read) and returns `SUCCESS`.
- If absent: returns `FAILURE`.
- Never returns `RUNNING` -- execution is synchronous with no inflight state.

The node extends `BaseNode` directly (not `ActionNode` or `ConditionNode`). This makes it non-reactive: when used inside a `SequenceNode`, its `SUCCESS` is cached in the sequence's `completedMap` and is not re-evaluated on subsequent ticks. This prevents the consumed blackboard key from being read twice.

### Optional payload mapping

```typescript
const node = receive("approve", {
  mapPayload: (payload, blackboard) => {
    blackboard.set("review:decision", (payload as any).decision);
  },
});
```

The `mapPayload` callback runs after the action key is consumed, letting you extract and rewrite data before subsequent nodes access it.

---

## EmitToClientNode

Sends structured data to the client via a dual write. Designed for the [application server](guide-app-server.md) where trees need to push UI updates to connected clients.

### Factory

```typescript
import { emitToClient } from "cartographer";

const node = emitToClient("ui:show_review", (ctx) => ({
  findings: ctx.blackboard.get("analysis"),
}));
```

### Behavior

When ticked, the node:

1. Calls the data function with the current `TreeContext`.
2. Writes the result to `clientEvents:<name>` on the blackboard (durable, survives serialization).
3. Emits a `client:event` event through the event system (real-time SSE delivery).
4. Returns `SUCCESS`.

`EmitToClientNode` extends `ActionNode`, so it uses the standard inflight pattern -- `RUNNING` on first tick, `SUCCESS` on the second after the action completes.

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
import { BaseNode, NodeStatus } from "cartographer";
import type { TreeContext } from "cartographer";

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

- `reset()` -- override if your node maintains state between ticks that should be cleared when the tree resets. `ActionNode` and `AgentNode` override `reset()` to clear inflight state, making the next tick start fresh.
- `abort()` -- override if your node starts work that should be cancelled when the tree is aborted (e.g., pending network requests, timers). `ActionNode` and `AgentNode` override `abort()` to clear inflight state and (for AgentNode) cancel the in-flight SDK request. After `abort()`, a `reset()` is required before the tree can tick again.
- `interrupt()` -- override if your node needs custom behavior when the tree is interrupted. The default implementation clears unsettled inflight state and recurses into children. Unlike `abort()`, interrupt preserves composite cycle state and does not require `reset()`. `AgentNode` overrides `interrupt()` to cancel the in-flight SDK request while preserving `cachedStatus`. See [Interrupt: Soft Cancellation](guide-error-handling.md#interrupt-soft-cancellation) for details.

`reset()` and `abort()` are no-ops by default on `BaseNode`. `interrupt()` has a default implementation that clears unsettled inflight state and recurses into children.

---

## Where to go next

- [Building Trees](guide-building-trees.md) -- `TreeBuilder`, nesting, and construction patterns.
- [Composite Nodes](guide-composites.md) -- selector, sequence, and parallel execution.
- [Decorator Nodes](guide-decorators.md) -- inverter, retry, guard, timeout, and more.
- [Agent Integration](guide-agent-integration.md) -- full `AgentNode` reference and advanced patterns.
