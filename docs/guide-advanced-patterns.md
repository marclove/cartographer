# Advanced Patterns

This guide covers custom node development, custom strategy implementation, multi-tick workflow internals, parallel node policies, advanced blackboard usage, and advanced YAML configurations.

---

## Custom Leaf Nodes

All nodes extend `BaseNode`. To create a custom leaf, implement the single abstract method `execute()`:

```typescript
import { BaseNode, NodeStatus } from "cartographer";
import type { TreeContext } from "cartographer";

class PingNode extends BaseNode {
  constructor() {
    super("ping");
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const host = context.blackboard.get<string>("host");
    const ok = await ping(host);
    return ok ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}
```

`BaseNode` handles everything else: UUID assignment, event emission (`node:enter`, `node:exit`, `node:error`), timing, and error containment.

### Optional Overrides

Override `reset()` if your node holds state that should be cleared between tree runs:

```typescript
class CounterNode extends BaseNode {
  private count = 0;

  constructor() {
    super("counter");
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    this.count++;
    context.blackboard.set("count", this.count);
    return this.count >= 3 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
  }

  reset(): void {
    this.count = 0;
  }
}
```

Override `abort()` if your node launches async operations that should be cancelled:

```typescript
class PollingNode extends BaseNode {
  private intervalId?: ReturnType<typeof setInterval>;

  constructor() {
    super("poller");
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // start polling...
    return NodeStatus.RUNNING;
  }

  abort(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  reset(): void {
    this.intervalId = undefined;
  }
}
```

Override `interrupt()` for soft cancellation that preserves progress. The default `BaseNode.interrupt()` clears unsettled inflight state and recurses into children — only override if your node needs additional cleanup beyond what the default provides:

```typescript
class WebSocketNode extends BaseNode {
  private socket?: WebSocket;

  constructor() {
    super("ws-listener");
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // connect and listen...
    return NodeStatus.RUNNING;
  }

  // interrupt() cancels the connection but preserves any accumulated state
  override interrupt(): void {
    this.socket?.close();
    this.socket = undefined;
    // Do NOT clear accumulated results — just stop the active connection.
    // The default super.interrupt() handles _inflightState and children.
    super.interrupt();
  }

  abort(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}
```

---

## Custom Strategies

Composites accept optional strategy objects that control child ordering or parallel success policies. The framework defines three strategy interfaces.

### SelectionStrategy (for SelectorNode)

Controls which order children are tried in a selector:

```typescript
interface SelectionStrategy {
  /** Return children in the order they should be evaluated. */
  order(children: BTreeNode[], context: TreeContext): BTreeNode[] | Promise<BTreeNode[]>;

  /** Reset any internal state (e.g., cached ordering). */
  reset?(): void;
}
```

### ExecutionStrategy (for SequenceNode)

Controls which order children are executed in a sequence:

```typescript
interface ExecutionStrategy {
  /** Return children in the order they should be executed. */
  order(children: BTreeNode[], context: TreeContext): BTreeNode[] | Promise<BTreeNode[]>;

  /** Reset any internal state (e.g., cached ordering). */
  reset?(): void;
}
```

### ParallelStrategy (for ParallelNode)

Controls the success/failure policy for a parallel node:

```typescript
interface ParallelPolicy {
  successCount?: number;
  successPercentage?: number;
  failureCount?: number;
}

interface ParallelStrategy {
  /** Return the policy that determines when the parallel succeeds or fails. */
  policy(children: BTreeNode[], context: TreeContext): ParallelPolicy | Promise<ParallelPolicy>;

  /** Reset any internal state (e.g., cached policy). */
  reset?(): void;
}
```

### Example: Priority-Based Selection Strategy

A custom strategy that reads priority scores from the blackboard and reorders children accordingly:

```typescript
import type { BTreeNode, TreeContext, SelectionStrategy } from "cartographer";

class PrioritySelectionStrategy implements SelectionStrategy {
  async order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]> {
    return [...children].sort((a, b) => {
      const pa = context.blackboard.get<number>(`priority:${a.name}`) ?? 0;
      const pb = context.blackboard.get<number>(`priority:${b.name}`) ?? 0;
      return pb - pa; // highest priority first
    });
  }
}

const selector = new SelectorNode({
  name: "dynamic-selector",
  children: [handlerA, handlerB, handlerC],
  strategy: new PrioritySelectionStrategy(),
});
```

### Strategy Lifecycle

- `order()` / `policy()` is called once per execution cycle (committed and reused across ticks within the cycle).
- `reset()` is called when the tree is reset. Use it to clear cached decisions.
- Agent strategies (`AgentSelectionStrategy`, `AgentExecutionStrategy`, `AgentParallelStrategy`) support `cache: true` to call Claude once and reuse the result until `reset()`.
- Agent strategies emit `agent:*` observability events (including `agent:prompt`, `agent:response`, `agent:error`) during SDK calls, so `createTreeLogger` and custom event listeners automatically capture strategy interactions.

### Dynamic Prompt Functions

Agent strategy configs accept a `prompt` that can be either a string or a function. Use a function to include dynamic blackboard state in the prompt:

```typescript
import { AgentExecutionStrategy } from "cartographer";

const strategy = new AgentExecutionStrategy({
  prompt: (ctx) => {
    const urgency = ctx.blackboard.get("urgency");
    return `Order steps for ${urgency} priority processing`;
  },
  options: { model: "claude-haiku-4-5-20251001" },
  cache: true,
});
```

---

## Context Layering

Context layering allows any node to override `TreeContext` fields for its descendants, similar to React's Context API. This is the mechanism behind per-subtree elicitation handlers, and it's available for custom use cases.

See the dedicated [TreeContext and Context Layering guide](guide-context.md) for the full explanation of how context overrides work, pinned fields, builder integration, and programmatic usage.

---

## Multi-Tick Stateful Workflows

Composites use a reactive re-evaluation model: on every tick, they re-evaluate from child 0, using `isReactiveNode()` to decide which children to re-tick vs cache. Understanding this model helps you build correct multi-tick workflows.

### Reactive Re-Evaluation with Caching

`SequenceNode` and `SelectorNode` re-evaluate from the beginning on every tick. Two kinds of children are handled differently:

- **Reactive children** (conditions, guards, decorators wrapping reactive children): Always re-ticked on every call to `execute()`. This enables preemption — a condition that was true on tick 1 may now be false, causing the composite to short-circuit before reaching a running action.
- **Non-reactive children** (actions, agents, composites): Their terminal results (SUCCESS or FAILURE) are cached within the current cycle. Cached children are not re-ticked, avoiding redundant work like repeated API calls.

The `isReactiveNode()` helper determines reactivity: `ConditionNode` and `GuardNode` are always reactive. Single-child decorators inherit reactivity from their child. Everything else is non-reactive.

### Sequence Re-Evaluation

```
Tick 1: [A=RUNNING]                                      → RUNNING
Tick 2: [A=cached SUCCESS]     [B=RUNNING]               → RUNNING  (A cached, not re-ticked)
Tick 3: [A=cached SUCCESS]     [B=cached SUCCESS] [C=SUCCESS] → SUCCESS
```

If A is a condition (reactive), it would be re-ticked on every tick instead of cached:

```
Tick 1: [A(cond)=SUCCESS] [B=RUNNING]               → RUNNING
Tick 2: [A(cond)=SUCCESS] [B=RUNNING]               → RUNNING  (A re-ticked, still passes)
Tick 3: [A(cond)=FAILURE]                            → FAILURE  (A re-ticked, fails — B is aborted)
```

### Selector Re-Evaluation with Preemption

```
Tick 1: [A(cond)=FAILURE] [B=RUNNING]        → RUNNING
Tick 2: [A(cond)=SUCCESS]                    → SUCCESS  (B aborted — higher-priority A preempts)
```

When a higher-priority reactive child succeeds while a lower-priority child is RUNNING, the lower-priority child is aborted and the selector returns SUCCESS immediately.

### Nested Composite Caching

Caching works through any depth of nesting. If a sequence contains a selector that returns SUCCESS, the sequence caches that result:

```
Tick 1: outer-seq → [A=cached SUCCESS] → inner-sel → [B=RUNNING]  → RUNNING
Tick 2: outer-seq → [A=cached SUCCESS] → inner-sel → [B=FAILURE] → [C=SUCCESS] → SUCCESS
```

A uses its cached result (non-reactive). The inner selector re-evaluates from its own child 0 on each tick.

### Decorator Counter Persistence

`RepeatNode` preserves its iteration counter across ticks. When a child returns `RUNNING`:

1. The repeat returns `RUNNING` immediately.
2. On the next tick, the repeat resumes at the same iteration.

This means a `RepeatNode(count=2)` with a child that returns `[RUNNING, SUCCESS, SUCCESS]` will:

- Tick 1: iteration 0 → child RUNNING → repeat RUNNING
- Tick 2: iteration 0 → child SUCCESS → iteration 1 → child SUCCESS → repeat SUCCESS

The child was ticked 3 times total across 2 tree ticks. Similarly, `RetryNode` preserves its attempt counter across ticks.

---

## Parallel Node Policies Deep Dive

`ParallelNode` ticks all children concurrently on every tick using `Promise.all`. Policies are evaluated on every tick with partial results, enabling early termination for some policy types.

### Early Termination

Unlike the old model where RUNNING blocked all policy evaluation, the reactive model evaluates policies with partial results:

- **`failureCount`** — if failures >= threshold, return `FAILURE` immediately, even with RUNNING children still in progress. Those children are aborted.
- **`successCount`** — if successes >= threshold, return `SUCCESS` immediately. If `successes + running < threshold`, return `FAILURE` (threshold impossible to reach). Otherwise `RUNNING`.
- **`successPercentage`** — requires all children to complete (no early exit). The denominator isn't meaningful with RUNNING children.
- **Default (no policy fields)** — any failure returns `FAILURE`; any RUNNING returns `RUNNING`; all SUCCESS returns `SUCCESS`.

```typescript
const parallel = new ParallelNode({
  name: "par",
  children: [fastChild, slowChild, anotherChild],
  strategy: new DefaultParallelStrategy({ failureCount: 2 }),
});

// Tick 1: fast=FAILURE, slow=RUNNING, another=FAILURE → 2 failures >= threshold → FAILURE (slow aborted)
```

The key implication: `failureCount` is always evaluated first and can veto a `successCount` that would otherwise pass.

### Reactive/Non-Reactive Caching in Parallel

Like sequences and selectors, parallel nodes distinguish between reactive and non-reactive children:

- **Reactive children** (conditions, guards) are re-ticked on every call to `execute()`.
- **Non-reactive children** (actions, agents) that already returned a terminal status are cached within the cycle and not re-ticked.

```typescript
// Tick 1: condition=SUCCESS, action=RUNNING → RUNNING
// Tick 2: condition re-ticked=SUCCESS, action cached=SUCCESS → SUCCESS (both resolved)
// Tick 2 alt: condition re-ticked=FAILURE, action cached=SUCCESS → depends on policy
```

---

## Advanced Blackboard Patterns

### Nested Scoping

`InMemoryBlackboard.scoped()` can be called multiple times to create deeply nested namespaces:

```typescript
import { InMemoryBlackboard } from "cartographer";

const bb = new InMemoryBlackboard();
const agentBb = bb.scoped("agent");
const subBb = agentBb.scoped("subtask");

subBb.set("result", "done");

// Each scope level adds a prefix separated by ':'
subBb.get("result"); // 'done'
agentBb.get("subtask:result"); // 'done'
bb.get("agent:subtask:result"); // 'done'
```

### Cross-Scope Visibility

Scoped views share the same underlying storage. The root blackboard can read any scoped key using its full prefixed name:

```typescript
const bb = new InMemoryBlackboard();
const scopedA = bb.scoped("a");
const scopedB = bb.scoped("b");

scopedA.set("x", 1);
scopedB.set("x", 2);

// Root can see both
bb.get("a:x"); // 1
bb.get("b:x"); // 2

// Scopes are isolated from each other
scopedA.get("x"); // 1 (doesn't see b:x)
scopedB.get("x"); // 2 (doesn't see a:x)
```

This is useful when a parent node needs to read results written by `AgentNode` children that use `blackboardNamespace`.

### Pre-Populating with Initial Values

`InMemoryBlackboard` accepts a `Record<string, unknown>` at construction:

```typescript
const bb = new InMemoryBlackboard({
  userId: 42,
  mode: "production",
  retryLimit: 3,
});

bb.get<number>("userId"); // 42
bb.get<string>("mode"); // 'production'
```

This is useful for initializing a tree with configuration or input data before the first tick.

### Snapshots with toRecord()

`InMemoryBlackboard` provides a `toRecord()` method that returns all stored key-value pairs as a plain object. This includes scoped keys with their full prefixes:

```typescript
const bb = new InMemoryBlackboard({ x: 1 });
bb.scoped("agent").set("result", "ok");

bb.toRecord();
// { x: 1, 'agent:result': 'ok' }
```

`BehaviorTree.run()` uses this internally to return the blackboard snapshot alongside the status:

```typescript
const { status, blackboard } = await tree.run();
console.log(blackboard); // plain object with all keys
```

---

## Advanced YAML Configurations

### Nested Decorators

Decorators can be nested arbitrarily in YAML. Each decorator has a `child` field that can be any node type, including another decorator:

```yaml
name: resilient-tree
root:
  type: sequence
  name: main
  children:
    - type: retry
      name: retry-timeout
      maxAttempts: 3
      delayMs: 500
      child:
        type: timeout
        name: capped
        timeoutMs: 5000
        child:
          type: action
          name: api-call
          ref: api-call
```

### Strategy References

Composite nodes can reference registered strategies via `strategy.ref`:

```yaml
name: adaptive-tree
root:
  type: selector
  name: handler
  strategy:
    ref: priority-strategy
  children:
    - type: action
      name: fast-path
      ref: fast-handler
    - type: action
      name: slow-path
      ref: slow-handler
```

Register the strategy before loading:

```typescript
import { TreeRegistry, TreeLoader } from "cartographer";

const registry = new TreeRegistry();
registry.registerStrategy("priority-strategy", new PrioritySelectionStrategy());
registry.registerAction("fast-handler", fastHandlerFn);
registry.registerAction("slow-handler", slowHandlerFn);

const tree = TreeLoader.fromYAML(yamlString, registry);
```

### Agent Nodes in YAML

`AgentNode` can be defined inline in YAML. Top-level fields mirror `AgentNodeConfig` (`name`, `prompt`, `blackboardNamespace`, `cache`), while SDK options are nested under `options:`:

```yaml
name: classifier
root:
  type: sequence
  name: pipeline
  children:
    - type: agent
      name: classify-intent
      prompt: "Classify the user's intent"
      blackboardNamespace: classify
      cache: true
      options:
        model: claude-haiku-4-5-20251001
        effort: low
    - type: agent
      name: generate-response
      prompt: "Generate a response based on the classification"
      options:
        model: claude-sonnet-4-6
        systemPrompt: "You are a helpful assistant"
        maxTurns: 5
        allowedTools:
          - search
          - lookup
```

The YAML structure maps directly to `AgentNodeConfig` — no registry lookups or transformations are needed for agent nodes.

### Complete YAML Example

A full tree combining composites, decorators, actions, conditions, and agents:

```yaml
name: support-pipeline
root:
  type: sequence
  name: main
  children:
    # Gate: only process if ticket is open
    - type: guard
      name: ticket-open
      conditionRef: is-ticket-open
      child:
        type: sequence
        name: process
        children:
          # Classify with AI
          - type: agent
            name: classify
            prompt: "Classify this support ticket"
            blackboardNamespace: classification
            options:
              model: claude-haiku-4-5-20251001

          # Try to auto-resolve, fall back to escalation
          - type: selector
            name: resolve
            children:
              - type: retry
                name: auto-resolve
                maxAttempts: 2
                child:
                  type: action
                  name: auto-fix
                  ref: auto-fix
              - type: action
                name: escalate
                ref: escalate-to-human

          # Repeat notification check
          - type: repeat
            name: poll-status
            count: 5
            untilStatus: success
            child:
              type: action
              name: check-resolved
              ref: check-resolved
```

---

## In-Flight Detection

Every node exposes two methods for introspecting async work:

- `hasInflightWork()` — Returns `true` if this node (or any descendant) has an unsettled promise (started but not yet resolved or rejected). Composites and decorators check their children recursively.
- `inflightPromise()` — Returns a `Promise<void>` that resolves when all unsettled work in the subtree has settled, or `null` if nothing is in flight.

At the tree level:

```typescript
const tree = new BehaviorTree({ name: 'test', root: myRoot });
await tree.tick();

if (tree.hasInflightWork()) {
  await tree.settled(); // waits for all in-flight work to resolve
}
```

These are primarily used by `TreeActor.runToCompletion()` to distinguish between a tree that is waiting for async work to finish (keep waiting) and a tree that has genuinely suspended (save state, exit).

---

## Content Hashing and Serialization

The [actor framework](guide-actor-framework.md) serializes tree execution state between messages using content-based Merkle hashing.

### Content Hashing

Every node computes a deterministic hash from its type, name, configuration, and children's hashes:

```typescript
import { computeContentHash } from 'cartographer';

// Leaf nodes hash from type + name
const hash = computeContentHash('ActionNode', 'fetch-data');

// Composites include ordered children hashes
const seqHash = computeContentHash('SequenceNode', [child1.contentHash(), child2.contentHash()]);
```

The root hash (`tree.rootHash`) fingerprints the entire tree topology. Same factory output produces the same root hash.

### Tree Serialization

```typescript
import { serializeTree, restoreTree, buildHashIndex } from 'cartographer';

// Serialize: walks the tree, collects each node's state keyed by content hash
const state = serializeTree(tree.root, tree.rootHash);
// state.nodes is { [contentHash]: NodeState }

// Restore: rebuilds node state from the serialized map
const hashToNode = buildHashIndex(tree.root);
restoreTree(tree.root, tree.rootHash, state);
```

Duplicate content hashes (e.g., two `ActionNode` instances with the same name) are disambiguated automatically with index suffixes (`abc123:0`, `abc123:1`).

---

## Next Steps

- [Actor Framework](guide-actor-framework.md) — TreeActor, ActorServer, StateStore, and client SDK.
- [TreeContext and Context Layering](guide-context.md) — How context overrides propagate through the tree.
- [Elicitation](guide-elicitation.md) — Handling MCP server input requests.
- [Building Trees](guide-building-trees.md) — Builder API, YAML config, and manual wiring compared side-by-side.
- [Agent Integration](guide-agent-integration.md) — AgentNode configuration, agent strategies, and MCP tool configuration.
- [Error Handling and Resilience](guide-error-handling.md) — Recovery patterns and abort semantics.
- [Testing Behavior Trees](guide-testing.md) — Test helpers and multi-tick test patterns.
