# Elicitation Support — Phase 1 Design

## Problem

When an MCP server connected to an `AgentNode` requests user input (OAuth flows, form fields, credentials), the Claude Agent SDK calls the `onElicitation` callback. If none is provided, the SDK silently declines the request. For an enterprise application framework, silent failure is unacceptable — operators need visibility into declined requests, and the framework should make it easy to set handlers at the right scope.

## Solution

Introduce **context layering** — a mechanism where any node in the tree can override fields on `TreeContext` for its descendants. Apply this to `onElicitation` as the first use case, with a wrapping layer in `AgentNode` that emits `agent:elicitation_declined` when no handler is found.

## Design Decisions

### Context layering in BaseNode

`BaseNode` gains an optional `contextOverrides` field of type `Partial<TreeContext>`. In `tick()`, before calling `execute()`, the base node merges any overrides onto the incoming context via shallow spread. Children receive the merged context, and their own overrides layer on top — closest override wins, like React Context providers.

```ts
// BaseNode.tick()
const effectiveContext = this.contextOverrides
  ? { ...context, ...this.contextOverrides, events: context.events, blackboard: context.blackboard }
  : context;
```

**Critical invariant:** The `events` and `blackboard` fields are *never* overridable. The tree-level event emitter is always preserved, guaranteeing a single observability point for the entire tree. The tree-level blackboard is always preserved as the single shared data store. Per-subtree blackboard *scoping* (via `ScopedBlackboard`) is a future feature that requires a different mechanism — a transform derived from the incoming context at tick time, not a static replacement. The merge explicitly pins both `events: context.events` and `blackboard: context.blackboard` after the spread.

No changes to any composite or decorator `execute()` method. The merge happens once in `BaseNode.tick()`.

### TreeContext changes

`TreeContext` gains a new optional field:

```ts
onElicitation?: OnElicitation;
```

Where `OnElicitation` is re-exported from `@anthropic-ai/claude-agent-sdk`.

### BehaviorTreeConfig changes

`BehaviorTreeConfig` gains:

```ts
onElicitation?: OnElicitation;
```

`BehaviorTree` sets this as `contextOverrides.onElicitation` on the root node during construction.

### AgentNode wrapping

`AgentNode.execute()` always provides a wrapped `onElicitation` to the SDK's `query()`. The wrapper:

1. Checks `this.config.options?.onElicitation` (node-level override — highest precedence)
2. Falls back to `context.onElicitation` (inherited from nearest ancestor with an override, or from tree-level default)
3. If neither exists, emits `agent:elicitation_declined` and returns `{ action: 'decline' }`

The SDK never handles elicitation on its own.

The `ElicitationResult` type (re-exported from the MCP SDK as `ElicitResult`) has the shape `{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }`. The `content` field is optional, so `{ action: 'decline' }` is a valid response.

### New event

`TreeEvents` gains:

```ts
'agent:elicitation_declined': {
  node: BTreeNode;
  request: ElicitationRequest;
};
```

`ElicitationRequest` is re-exported from the SDK for user convenience.

### TreeBuilder API

`TreeBuilder` gets a chainable `onElicitation()` method:

```ts
new TreeBuilder('my-tree')
  .onElicitation(handler)
  .sequence('root', (b) => { ... })
  .build();
```

Composite and decorator methods on both `CompositeBuilder` and `SingleChildBuilder` accept an optional `context` field in their options for per-subtree overrides:

```ts
b.sequence('oauth-flow', { context: { onElicitation: oauthHandler } }, (b) => {
  b.agent('login', { prompt: '...' });
});
```

### TreeLoader

`onElicitation` is added to the non-serializable options table. No YAML changes. Users who load from YAML must set it programmatically.

## Out of scope

- **Agent strategies**: `AgentSelectionStrategy`, `AgentExecutionStrategy`, and `AgentParallelStrategy` also call `query()` but do not participate in elicitation wrapping in this phase. Tracked as Phase 1.5 in ROADMAP.md.

## Testing

**Unit tests:**
- `BaseNode`: contextOverrides merges onto context; children inherit; child overrides shadow parent's; `events` is never overridable; `mergeContextOverrides()` works correctly
- `BehaviorTree`: constructor wires `onElicitation` from config onto root node's contextOverrides
- `AgentNode`: wrapping delegates to context.onElicitation; emits `agent:elicitation_declined` when no handler; node-level options.onElicitation takes precedence; always provides `onElicitation` to SDK
- `TreeBuilder`: `onElicitation()` method flows through to `BehaviorTreeConfig`; `context` option works on composites and decorators in both `CompositeBuilder` and `SingleChildBuilder`

**Integration tests:**
- Full tree with tree-level onElicitation, verify handler is called
- Subtree override takes precedence over tree-level
- Deeply nested node (3+ levels) inherits from grandparent
- No handler anywhere emits `agent:elicitation_declined`
- Node-level `options.onElicitation` overrides context-level
- Events always emit to tree-level emitter regardless of context overrides

## Scope

This is Phase 1 (passthrough + observability). Phases 1.5 (agent strategies), 2 (tree-aware elicitation via events/blackboard routing), and 3 (automated elicitation from blackboard data) are tracked in ROADMAP.md.
