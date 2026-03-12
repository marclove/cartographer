# TreeContext and Context Layering

`TreeContext` is the execution context passed to every node during a tree tick. Context layering allows any node to override context fields for its descendants, similar to React's Context API.

---

## What TreeContext Carries

A `TreeContext` is created at the start of each `BehaviorTree.tick()` call and flows through every node in the tree:

```typescript
interface TreeContext {
  /** Shared key-value store for inter-node communication. */
  blackboard: Blackboard;

  /** Event emitter for observing tree execution. */
  events: TypedEventEmitter<TreeEvents>;

  /** Optional signal for cooperative cancellation. */
  signal?: AbortSignal;

  /** Handler for MCP elicitation requests. */
  onElicitation?: OnElicitation;
}
```

| Field            | Purpose                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `blackboard`     | Shared key-value store for inter-node communication. All nodes read from and write to this store.  |
| `events`         | Event emitter for observability. All `node:*` and `agent:*` events flow through this emitter.      |
| `signal`         | Set automatically by `BehaviorTree` when `abort()` is called. Nodes check `signal?.aborted` to bail out of long-running work. |
| `onElicitation`  | Handler for MCP server elicitation requests. Consumed by `AgentNode` and agent strategies. See [Elicitation](guide-elicitation.md). |

### Creating a Context

`BehaviorTree` creates the context internally. In tests, construct one manually:

```typescript
import { MapBlackboard, EventEmitter } from 'cartographer';
import type { TreeContext, TreeEvents } from 'cartographer';

const context: TreeContext = {
  blackboard: new MapBlackboard(),
  events: new EventEmitter<TreeEvents>(),
};

const status = await myNode.tick(context);
```

### Context Propagation

The context flows top-down through the tree. Composite nodes pass it to each child, and decorators pass it to their single child. Every node in the tree receives the same context object — unless a node along the path applies context overrides.

---

## Context Layering

Context layering lets any `BaseNode` override `TreeContext` fields for itself and all its descendants. This is how per-subtree elicitation handlers are implemented — both `AgentNode` and agent strategies (`AgentSelectionStrategy`, `AgentExecutionStrategy`, `AgentParallelStrategy`) read `context.onElicitation` during their SDK calls.

### How It Works

When a node has context overrides set (via `setContextOverrides()` or `mergeContextOverrides()`), `tick()` shallow-merges those overrides onto the incoming `TreeContext` before calling `execute()`:

```typescript
// Inside BaseNode.tick()
const effectiveContext = this.contextOverrides
  ? { ...context, ...this.contextOverrides, events: context.events, blackboard: context.blackboard }
  : context;
```

### Pinned Fields

Two fields are pinned and can never be overridden, regardless of what you pass:

- **`events`** — All events always reach the tree-level emitter. This guarantees a single observability point.
- **`blackboard`** — The shared state store is always the same instance. Per-subtree data isolation is handled by [blackboard scoping](guide-blackboard-and-events.md), not by context overrides.

### Precedence

The closest override to a given node wins. If a grandparent sets `onElicitation` to handler A and a parent sets it to handler B, children of the parent see handler B:

```
root (onElicitation: handlerA)
  └─ sequence (onElicitation: handlerB)
       └─ agent → sees handlerB
  └─ agent → sees handlerA
```

---

## Using Context Overrides in the Builder

The `context` option on composite and decorator builder methods calls `setContextOverrides()` on the constructed node:

```typescript
import { TreeBuilder } from 'cartographer';

const tree = new TreeBuilder('example')
  .sequence('outer', { context: { onElicitation: outerHandler } }, (b) => {
    // inner override takes precedence for its descendants
    b.sequence('inner', { context: { onElicitation: innerHandler } }, (b) => {
      b.agent('worker', { prompt: 'work' }); // sees innerHandler
    });
    b.agent('sibling', { prompt: 'other' }); // sees outerHandler
  })
  .build();
```

The `context` option is available on all composite methods (`sequence`, `selector`, `parallel`) and all decorator methods (`inverter`, `retry`, `timeout`, `guard`, `alwaysSucceed`, `alwaysFail`, `repeat`).

---

## Using Context Overrides Programmatically

When constructing nodes directly (without the builder), call `setContextOverrides()` or `mergeContextOverrides()` on any `BaseNode` subclass:

```typescript
import { SequenceNode, AgentNode } from 'cartographer';

const seq = new SequenceNode({
  name: 'scoped',
  children: [new AgentNode({ name: 'agent', prompt: 'work' })],
});

// Replace all overrides
seq.setContextOverrides({ onElicitation: myHandler });

// Or merge onto existing overrides
seq.mergeContextOverrides({ onElicitation: anotherHandler });
```

`setContextOverrides()` replaces all overrides. `mergeContextOverrides()` shallow-merges onto any existing overrides, which is useful when multiple systems need to contribute overrides to the same node (e.g., the tree-level `onElicitation` is merged onto the root node by `BehaviorTree`).

---

## Design Rationale

Context layering follows the React Context pattern: a provider sets a value, and any descendant consumer reads it. The closest provider wins. This design was chosen because:

1. **Scoped configuration without global state.** Different subtrees can have different handlers without polluting the shared blackboard or requiring nodes to be aware of the tree structure.
2. **Composable.** Handlers can be layered — a tree-level default with per-branch overrides — without any coordination between the layers.
3. **Safe by default.** Pinning `events` and `blackboard` prevents accidental fragmentation of observability or shared state.

---

## Where to Go Next

- [Elicitation](guide-elicitation.md) — The primary use case for context layering today.
- [Agent Integration](guide-agent-integration.md) — AgentNode configuration and MCP tools.
- [Advanced Patterns](guide-advanced-patterns.md) — Custom nodes, strategies, and multi-tick workflows.
