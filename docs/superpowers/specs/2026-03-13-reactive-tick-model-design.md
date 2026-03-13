# Reactive Tick Model Design

**Date:** 2026-03-13
**Status:** Draft

## Problem

Cartographer's current execution model runs each tick to completion — `AgentNode` blocks for the entire duration of a Claude API call, and composites skip already-succeeded children when resuming. This makes the tree unresponsive to external state changes. A human operator changing blackboard values (via dashboard, API, etc.) won't be noticed until the current tick finishes, which could take seconds or minutes.

## Goal

Make the behavior tree reactive to blackboard changes from outside actors within ~1 second, following traditional BT patterns with frequent ticks and RUNNING nodes. The tree should re-evaluate conditions on every tick, abort in-progress work when upstream conditions change, and do all of this without requiring node authors to manage non-blocking execution themselves.

## Design

### 1. Non-Blocking Execution at BaseNode Level

`BaseNode.tick()` gains the ability to detect long-running `execute()` calls and return RUNNING automatically.

**Mechanism:**

```
tick(context):
  // Poll phase: if there's an in-flight execution, check completion
  if (this._inflight):
    if (this._inflight settled):
      clear inflight state
      emit node:exit
      return settled status

    else:
      return RUNNING

  // Start phase: begin new execution
  emit node:enter
  promise = this.execute(context)

  // Yield to microtask queue to detect synchronous resolution
  await microtask

  if (promise settled):
    // Fast path: sync or near-sync work (conditions, quick actions)
    emit node:exit
    return result

  // Slow path: long-running async work
  this._inflight = promise
  promise.then(status => this._inflightResult = status)
  return RUNNING
```

**Properties:**

- **Transparent to node authors.** The `execute()` signature is unchanged. Nodes that resolve quickly (conditions, fast actions) hit the fast path and never return RUNNING from this mechanism.
- **Abort wiring.** The in-flight promise respects `context.signal`. When `abort()` is called, the signal fires, and well-behaved async work cancels. `reset()` clears in-flight state.
- **Error handling.** If the in-flight promise rejects, the next tick that polls it re-throws, triggering `node:error` through existing BaseNode error handling.
- **Event semantics.** `node:enter` fires on the tick that starts execution. `node:exit` fires on the tick that observes completion. These may be different ticks.
- **Backwards compatible.** If you never tick faster than your slowest node, you get today's behavior. This is purely additive.

**Microtask yield explained:** `await Promise.resolve()` briefly yields to the JavaScript microtask queue, allowing already-resolved promises to flush their `.then()` callbacks. This is how we distinguish "fast" (resolved within one microtask) from "slow" (truly async — HTTP calls, SDK queries). A condition checking a blackboard value resolves instantly and returns its result. An AgentNode calling the SDK doesn't resolve, so it's stored for polling.

### 2. Reactive Composites

All composites become reactive. `SequenceNode` and `SelectorNode` re-evaluate children from the start on every tick, even when a later child is RUNNING. There are no separate reactive/non-reactive variants.

**Sequence behavior:**

```
tick(context):
  // Resolve strategy if needed (see Section 3)
  // Then for each child in committed order:

  for each child in committed order:
    status = child.tick(context)

    if status == FAILURE:
      abort any RUNNING children later in the sequence
      return FAILURE

    if status == RUNNING:
      abort any RUNNING children later in the sequence
      return RUNNING

    // status == SUCCESS: continue to next child

  return SUCCESS
```

**Selector behavior:**

```
tick(context):
  for each child in committed order:
    status = child.tick(context)

    if status == SUCCESS:
      abort any RUNNING children later in the selector
      return SUCCESS

    if status == RUNNING:
      // Don't try lower-priority branches
      return RUNNING

    // status == FAILURE: try next child

  return FAILURE
```

Higher-priority branches are always re-checked. If branch 1 was FAILURE and branch 3 was RUNNING, but now branch 1 succeeds, branch 3 is aborted and the selector returns SUCCESS.

**Interaction with non-blocking nodes:** When a reactive composite ticks a RUNNING child (e.g., an AgentNode mid-API-call), that child's `tick()` hits the poll path in BaseNode — checks if the in-flight promise settled, returns RUNNING or the final status. This is fast and non-blocking.

### 3. Cycle-Based Completion Tracking

A "cycle" is the span from when a composite begins working through its children until it returns a terminal status (SUCCESS or FAILURE). Across multiple ticks where the composite returns RUNNING, you're in the same cycle. When it returns SUCCESS or FAILURE, the cycle ends. Next time the composite is ticked, a new cycle begins — cached completions are cleared.

**The re-execution problem:** In a reactive sequence `[Condition, Action, AgentNode]`, every tick re-evaluates from the start. Re-checking the Condition is the whole point. But if Action already succeeded, re-ticking it would re-execute it — wrong for side-effectful actions.

**Solution:** Composites track which children have completed (SUCCESS) during the current cycle:

- **ConditionNodes** are always re-ticked. They're stateless checks — this is the purpose of reactivity.
- **Other nodes** (actions, agents, decorators, sub-composites) that returned SUCCESS in this cycle return their cached result without re-executing.
- **RUNNING nodes** are ticked (polled) normally.

The composite distinguishes conditions from other nodes via `child instanceof ConditionNode`.

**Cycle lifecycle:**

- **Start:** Composite is ticked with no active cycle (fresh, or after previous cycle ended). Completion cache is empty.
- **During:** Each tick re-evaluates from the start. Conditions re-checked, completed non-conditions return cached result, RUNNING nodes polled.
- **End:** Composite returns SUCCESS or FAILURE. Completion cache cleared.
- **Abort:** Composite aborted mid-cycle — completion cache cleared, in-flight children aborted.

**Nested composites:** A child that is itself a Sequence manages its own cycle independently. The parent sees it as a node that returned SUCCESS, FAILURE, or RUNNING. If the parent caches the child composite's SUCCESS, the child's internal cycle state is irrelevant.

**Example:**

```
Tick 1: Cond -> SUCCESS, Action starts -> RUNNING.    Sequence -> RUNNING.  (cycle started)
Tick 2: Cond -> SUCCESS, Action polls  -> SUCCESS.    Agent starts -> RUNNING. Sequence -> RUNNING. (same cycle, Action cached)
Tick 3: Cond -> FAILURE. Agent aborted.               Sequence -> FAILURE. (cycle ended, cache cleared)
Tick 4: Cond -> SUCCESS. Action re-executes.           (new cycle)
```

### 4. Strategy Handling

Strategy calls get the same non-blocking treatment as node execution. Composites handle pending strategy calls as their own RUNNING state.

**Lifecycle:**

```
tick(context):
  // Phase 1: Strategy resolution
  if (strategyPending):
    if (strategyResult settled):
      committedOrder = strategyResult
      clear strategyPending
    else:
      return RUNNING

  if (committedOrder === null):
    promise = strategy.orderChildren(children, context)

    // Same microtask yield pattern as BaseNode
    await microtask

    if (promise settled):
      committedOrder = result
    else:
      strategyPending = promise
      return RUNNING

  // Phase 2: Tick children in committed order (reactive traversal)
```

**Committed order reset:** Same as current model — the order stays locked for the duration of a cycle. Reactive re-evaluation re-ticks children in the same committed order. The strategy is only re-consulted when a new cycle begins.

**`evaluatePolicy` for Parallel:** Same pattern. If policy evaluation is async, Parallel stores the pending promise and returns RUNNING until it resolves.

### 5. Abort and Cleanup on Preemption

When a reactive composite determines that a RUNNING subtree should be preempted (upstream condition failed, higher-priority branch succeeded), it aborts that subtree.

**Abort flow:**

1. Composite detects preemption condition.
2. Calls `abort()` on preempted children (cascades through the subtree).
3. In-flight promises are abandoned (results, if they arrive later, are ignored).
4. Composite returns FAILURE or tries the next branch (depending on type).

**BaseNode.abort() changes:** Today `abort()` is a no-op on BaseNode. With non-blocking execution, it must also clear in-flight state:

```
abort():
  if (this._inflight):
    // AbortSignal handles actual cancellation of underlying work
    this._inflight = null
    this._inflightResult = null
```

**No reset between ticks.** State persists across the tick loop. Cleanup happens surgically — only preempted subtrees get aborted. Non-preempted RUNNING nodes continue undisturbed.

**Abort during strategy resolution:** If a composite is waiting on a strategy call and gets aborted by a parent, the pending strategy promise is cleared. Strategies have no side effects to roll back.

**No recovery on abort.** The SDK call is cancelled, partial work is lost. If the tree routes back to that agent later, it starts fresh.

### 6. `BehaviorTree.run()` API

The tree gains a `run()` method that starts a fixed-interval tick loop.

```typescript
// Start ticking every second
const handle = tree.run({ intervalMs: 1000 });

// Stop the loop
handle.stop();

// Or with an AbortSignal
const ac = new AbortController();
tree.run({ intervalMs: 1000, signal: ac.signal });
ac.abort(); // stops the loop
```

**Behavior:**

- Ticks immediately on start (no initial delay), then every `intervalMs`.
- If a tick is still in progress when the next interval fires, skip that tick. Ticks should be fast (polling and condition checks), so this is a safeguard.
- No reset between ticks — state persists.
- On `stop()`: cancels the interval, calls `tree.abort()` to clean up in-flight work.

**Events:**

- Existing `tree:tick` fires after each tick with status and duration.
- New `tree:tick:skipped` when a tick is skipped due to overlap.

**Stop conditions** are handled in userland via event listeners:

```typescript
tree.events.on('tree:tick', ({ status }) => {
  if (status === NodeStatus.SUCCESS) handle.stop();
});
```

**Existing scheduler** remains unchanged for cron and one-shot use cases.

### 7. Impact on Existing Nodes

**ConditionNode** — No changes. Stateless, fast. Always re-evaluated by reactive composites.

**ActionNode** — No changes. Non-blocking BaseNode infrastructure handles slow actions automatically.

**AgentNode** — No changes to `execute()`. The SDK call is long-running async — BaseNode makes it non-blocking automatically. Abort wiring already exists. Streaming events (`agent:text`, `agent:thinking`, etc.) continue to fire in the background while the node is RUNNING. Cache behavior (`cache: true`) continues to work but is less relevant since composites handle cycle-based caching.

**Decorators:**

- **Timeout** — Already uses AbortSignal with a deadline. Compatible with polling.
- **Retry/Repeat** — Track their own state (retry/repeat count) on the instance. Works across ticks.
- **Guard** — Needs a small change: re-check its condition on every tick while the child is RUNNING, not just on initial entry.
- **Inverter, AlwaysSucceed, AlwaysFail** — Pass through child status. No changes.

**ParallelNode** — Already ticks all children concurrently via `Promise.all()`. With non-blocking BaseNode, RUNNING children are polled in parallel. Policy evaluation gets the same async treatment as strategy calls. Cycle-based caching does not apply since Parallel re-ticks all children by nature.

### 8. Testing Strategy

**Multi-tick test pattern:**

```typescript
const status1 = await tree.tick(context);
expect(status1).toBe(NodeStatus.RUNNING);

// Simulate external blackboard change
context.blackboard.set('approved', false);

const status2 = await tree.tick(context);
expect(status2).toBe(NodeStatus.FAILURE);
```

Tests call `tick()` manually without using `run()`. No new test infrastructure required.

**Testing non-blocking nodes with deferred promises:**

```typescript
let resolve: () => void;
const slowAction = async () => {
  await new Promise(r => { resolve = r; });
  return NodeStatus.SUCCESS;
};

// Tick 1: action starts, returns RUNNING
const s1 = await tree.tick(context);
expect(s1).toBe(NodeStatus.RUNNING);

// Simulate completion
resolve();

// Tick 2: action complete, returns SUCCESS
const s2 = await tree.tick(context);
expect(s2).toBe(NodeStatus.SUCCESS);
```

**Key scenarios to cover:**

- Condition changes mid-cycle cause abort of RUNNING children
- Completed actions are not re-executed within a cycle
- Conditions ARE re-evaluated every tick
- Abort cleans up in-flight promises
- Fast nodes never return RUNNING (microtask fast path)
- Cycle cache clears when cycle ends (SUCCESS/FAILURE)
- Nested composites manage independent cycles
- `tree.run()` tick loop: interval timing, skip-on-overlap, clean shutdown
- Strategy resolution across ticks (fast strategies resolve immediately, slow strategies return RUNNING)
- Guard re-checks condition while child is RUNNING

**Existing tests:** Most current unit and integration tests should continue to pass since single-tick execution is a degenerate case (all nodes resolve immediately). Tests asserting specific `runningChildId` behavior will need updating since that mechanism is replaced by reactive re-evaluation with cycle-based caching.
