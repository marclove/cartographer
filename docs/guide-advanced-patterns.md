# Advanced Patterns

This guide covers custom node development, custom strategy implementation, multi-tick workflow internals, parallel node policies, advanced blackboard usage, and advanced YAML configurations.

---

## Custom Leaf Nodes

All nodes extend `BaseNode`. To create a custom leaf, implement the single abstract method `execute()`:

```typescript
import { BaseNode, NodeStatus } from 'cartographer';
import type { TreeContext } from 'cartographer';

class PingNode extends BaseNode {
  constructor() {
    super('ping');
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const host = context.blackboard.get<string>('host');
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
    super('counter');
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    this.count++;
    context.blackboard.set('count', this.count);
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
    super('poller');
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

---

## Custom Strategies

Composites accept optional strategy objects that control child ordering or parallel success policies. The framework defines three strategy interfaces.

### SelectionStrategy (for SelectorNode)

Controls which order children are tried in a selector:

```typescript
interface SelectionStrategy {
  /** Return children in the order they should be evaluated. */
  order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]>;

  /** Reset any internal state (e.g., cached ordering). */
  reset?(): void;
}
```

### ExecutionStrategy (for SequenceNode)

Controls which order children are executed in a sequence:

```typescript
interface ExecutionStrategy {
  /** Return children in the order they should be executed. */
  order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]>;

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
  policy(children: BTreeNode[], context: TreeContext): Promise<ParallelPolicy>;

  /** Reset any internal state (e.g., cached policy). */
  reset?(): void;
}
```

### Example: Priority-Based Selection Strategy

A custom strategy that reads priority scores from the blackboard and reorders children accordingly:

```typescript
import type { BTreeNode, TreeContext, SelectionStrategy } from 'cartographer';

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
  name: 'dynamic-selector',
  children: [handlerA, handlerB, handlerC],
  strategy: new PrioritySelectionStrategy(),
});
```

### Strategy Lifecycle

- `order()` / `policy()` is called on every tick. If your strategy is expensive (e.g., it calls an API), implement caching.
- `reset()` is called when the tree is reset. Use it to clear cached decisions.
- Agent strategies (`AgentSelectionStrategy`, `AgentExecutionStrategy`, `AgentParallelStrategy`) support `cache: true` to call Claude once and reuse the result until `reset()`.
- Agent strategies emit `agent:*` observability events (including `agent:prompt`, `agent:response`, `agent:error`) during SDK calls, so `createTreeLogger` and custom event listeners automatically capture strategy interactions.

### Dynamic Prompt Functions

Agent strategy configs accept a `prompt` that can be either a string or a function. Use a function to include dynamic blackboard state in the prompt:

```typescript
import { AgentExecutionStrategy } from 'cartographer';

const strategy = new AgentExecutionStrategy({
  prompt: (ctx) => {
    const urgency = ctx.blackboard.get('urgency');
    return `Order steps for ${urgency} priority processing`;
  },
  options: { model: 'claude-haiku-4-5-20251001' },
  cache: true,
});
```

---

## Multi-Tick Stateful Workflows

When a child returns `RUNNING`, composites remember which child was in progress and resume from it on the next tick. Understanding the internals helps you build correct multi-tick workflows.

### ID-Based Resumption

`SequenceNode` and `SelectorNode` track the running child by its UUID, not its array index. This matters because:

1. Strategy reordering between ticks cannot cause the wrong child to be resumed.
2. The sequence finds the running child in the newly ordered list by ID and resumes from that position.

```typescript
// Internally in SequenceNode:
if (this.runningChildId !== null) {
  const resumeIndex = ordered.findIndex((c) => c.id === this.runningChildId);
  if (resumeIndex !== -1) {
    startIndex = resumeIndex;
  }
}
```

### Sequence Resumption

When a sequence child returns `RUNNING`:
1. The sequence stores that child's ID and returns `RUNNING`.
2. On the next tick, the sequence skips all children before the running child.
3. When the running child finally returns `SUCCESS`, the sequence continues with the next child.
4. If the running child returns `FAILURE`, the sequence returns `FAILURE` (remaining children are skipped).

```
Tick 1: [A=SUCCESS] [B=RUNNING] [C=skipped] → RUNNING
Tick 2:             [B=RUNNING] [C=skipped] → RUNNING  (A not re-ticked)
Tick 3:             [B=SUCCESS] [C=SUCCESS] → SUCCESS
```

### Selector Resumption

When a selector child returns `RUNNING`:
1. The selector stores that child's ID and returns `RUNNING`.
2. On the next tick, the selector resumes at that child.
3. If the running child returns `FAILURE`, the selector continues to the next sibling (fallback behavior).

```
Tick 1: [A=RUNNING]              → RUNNING
Tick 2: [A=FAILURE] [B=SUCCESS]  → SUCCESS  (fallback after A resolved)
```

### Nested Composite Resumption

Resumption works through any depth of nesting. If a sequence contains a selector that contains a RUNNING action, each layer remembers its running child:

```
Tick 1: outer-seq → [A=SUCCESS] → inner-sel → [B=RUNNING]  → RUNNING
Tick 2: outer-seq resumes at inner-sel → inner-sel resumes at B → [B=RUNNING] → RUNNING
Tick 3: outer-seq resumes at inner-sel → [B=FAILURE] → [C=SUCCESS] → SUCCESS
```

A is never re-ticked because the outer sequence remembers it already completed.

### Decorator Restart Semantics

`RepeatNode` does not track its iteration counter across ticks. When a child returns `RUNNING`:

1. The repeat returns `RUNNING` immediately.
2. On the next tick, the repeat restarts from iteration zero.

This means a `RepeatNode(count=2)` with a child that returns `[RUNNING, SUCCESS, SUCCESS]` will:
- Tick 1: iteration 0 → child RUNNING → repeat RUNNING
- Tick 2: restart → iteration 0 → child SUCCESS → iteration 1 → child SUCCESS → repeat SUCCESS

The child was ticked 3 times total across 2 tree ticks.

---

## Parallel Node Policies Deep Dive

`ParallelNode` ticks all children concurrently on every tick using `Promise.all`. After collecting results, it applies the policy — but only if no children are still `RUNNING`.

### Evaluation Order

1. All children are ticked concurrently.
2. If any child returned `RUNNING`, the parallel returns `RUNNING`. Policy evaluation is deferred.
3. `failureCount` is checked first. If failures meet the threshold, return `FAILURE`.
4. `successPercentage` is checked next. If the ratio meets the threshold, return `SUCCESS`; otherwise `FAILURE`.
5. `successCount` is checked last. If successes meet the threshold, return `SUCCESS`; otherwise `FAILURE`.
6. Default (no policy fields): return `SUCCESS` only if zero failures.

The key implication: `failureCount` can veto a `successCount` that would otherwise pass. If you set both `failureCount: 2` and `successCount: 2`, and 2 children succeed while 2 fail, the result is `FAILURE` because `failureCount` is evaluated first.

### RUNNING Blocks Policy Evaluation

This is important for correctness: a parallel node does not evaluate any policy while any child is still `RUNNING`. All children must resolve to `SUCCESS` or `FAILURE` before thresholds are checked.

```typescript
const parallel = new ParallelNode({
  name: 'par',
  children: [fastChild, slowChild],
  strategy: new DefaultParallelStrategy({ failureCount: 2 }),
});

// Tick 1: fast=SUCCESS, slow=RUNNING → RUNNING (policy NOT checked)
// Tick 2: fast=SUCCESS, slow=FAILURE → policy checked → 1 failure < 2 → SUCCESS
```

### All Children Re-Ticked Every Tick

Unlike sequences and selectors, parallel nodes do not skip children. Every child is re-ticked on every call to `execute()`, even if it previously returned `SUCCESS` or `FAILURE`. Stateful children must manage their own multi-tick behavior.

---

## Advanced Blackboard Patterns

### Nested Scoping

`MapBlackboard.scoped()` can be called multiple times to create deeply nested namespaces:

```typescript
import { MapBlackboard } from 'cartographer';

const bb = new MapBlackboard();
const agentBb = bb.scoped('agent');
const subBb = agentBb.scoped('subtask');

subBb.set('result', 'done');

// Each scope level adds a prefix separated by ':'
subBb.get('result');          // 'done'
agentBb.get('subtask:result'); // 'done'
bb.get('agent:subtask:result'); // 'done'
```

### Cross-Scope Visibility

Scoped views share the same underlying storage. The root blackboard can read any scoped key using its full prefixed name:

```typescript
const bb = new MapBlackboard();
const scopedA = bb.scoped('a');
const scopedB = bb.scoped('b');

scopedA.set('x', 1);
scopedB.set('x', 2);

// Root can see both
bb.get('a:x'); // 1
bb.get('b:x'); // 2

// Scopes are isolated from each other
scopedA.get('x'); // 1 (doesn't see b:x)
scopedB.get('x'); // 2 (doesn't see a:x)
```

This is useful when a parent node needs to read results written by `AgentNode` children that use `blackboardNamespace`.

### Pre-Populating with Initial Values

`MapBlackboard` accepts a `Record<string, unknown>` at construction:

```typescript
const bb = new MapBlackboard({
  userId: 42,
  mode: 'production',
  retryLimit: 3,
});

bb.get<number>('userId');     // 42
bb.get<string>('mode');       // 'production'
```

This is useful for initializing a tree with configuration or input data before the first tick.

### Snapshots with toRecord()

`MapBlackboard` provides a `toRecord()` method that returns all stored key-value pairs as a plain object. This includes scoped keys with their full prefixes:

```typescript
const bb = new MapBlackboard({ x: 1 });
bb.scoped('agent').set('result', 'ok');

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
import { TreeRegistry, TreeLoader } from 'cartographer';

const registry = new TreeRegistry();
registry.registerStrategy('priority-strategy', new PrioritySelectionStrategy());
registry.registerAction('fast-handler', fastHandlerFn);
registry.registerAction('slow-handler', slowHandlerFn);

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

## Next Steps

- [Building Trees](guide-building-trees.md) — Builder API, YAML config, and manual wiring compared side-by-side.
- [Agent Integration](guide-agent-integration.md) — AgentNode configuration, agent strategies, and MCP tool configuration.
- [Error Handling and Resilience](guide-error-handling.md) — Recovery patterns and abort semantics.
- [Testing Behavior Trees](guide-testing.md) — Test helpers and multi-tick test patterns.
