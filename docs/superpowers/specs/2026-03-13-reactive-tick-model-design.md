# Reactive Tick Model Design

**Date:** 2026-03-13
**Status:** Draft

## Problem

Cartographer's current execution model runs each tick to completion — `AgentNode` blocks for the entire duration of a Claude API call, and composites skip already-succeeded children when resuming. This makes the tree unresponsive to external state changes. A human operator changing blackboard values (via dashboard, API, etc.) won't be noticed until the current tick finishes, which could take seconds or minutes.

## Goal

Make the behavior tree reactive to blackboard changes from outside actors within ~1 second, following traditional BT patterns with frequent ticks and RUNNING nodes. The tree should re-evaluate conditions on every tick, abort in-progress work when upstream conditions change, and do all of this without requiring node authors to manage non-blocking execution themselves.

## Design

### 1. Non-Blocking Leaf Nodes

Leaf nodes that perform long-running work (ActionNode, AgentNode) manage their own inflight state as instance fields. On the first tick they start the async work and return RUNNING immediately. On subsequent ticks they poll for completion and return RUNNING or the final status.

**BaseNode.tick() is unchanged** — it remains a simple wrapper: emit `node:enter`, call `await this.execute(context)`, emit `node:exit`. There is no microtask yield, no inflight tracking, and no special RUNNING detection in BaseNode. All nodes — leaves, composites, decorators — go through the same lifecycle. One implementation, no bypass.

**ActionNode.execute() inflight pattern:**

```
execute(context):
  // Poll: if there's in-flight work, check completion
  if (this._inflightState):
    if (this._inflightState.result !== undefined):
      result = this._inflightState.result
      this._inflightState = null
      return result
    else:
      return RUNNING

  // Start: kick off the action, return RUNNING immediately
  state = { promise: this.action(context) }
  state.promise.then(
    status => state.result = status,
    error  => state.error = error
  )
  this._inflightState = state
  return RUNNING
```

This means ActionNode *always* returns RUNNING on the first tick, even for fast synchronous actions. This is acceptable — a fast action resolves before the next tick, so the composite sees RUNNING once and SUCCESS on the next tick. The simplicity of a single code path (no microtask yield to distinguish fast vs slow) outweighs the cost of one extra tick for fast actions.

**AgentNode.execute()** follows the same pattern. It already has `activeAbortController` and similar instance state, so inflight tracking is a natural fit. The SDK call runs in the background; streaming events (`agent:text`, `agent:thinking`, etc.) continue to fire while the node is RUNNING.

**ConditionNode** — No changes needed. Condition functions are synchronous or near-synchronous boolean checks. `execute()` evaluates the condition and returns SUCCESS/FAILURE immediately. No inflight tracking.

**Abort and reset:** ActionNode and AgentNode clear their inflight state on `abort()` and `reset()`. The AbortSignal (for nodes that support hard cancellation like AgentNode) continues to work as today.

### 2. Reactive Composites

All composites become reactive. `SequenceNode` and `SelectorNode` re-evaluate children from the start on every tick, even when a later child is RUNNING. There are no separate reactive/non-reactive variants.

Composites stay in `execute()` as they do today. Since child `tick()` calls now return quickly (leaves return RUNNING immediately or a final status), composite `execute()` always resolves fast. No `tick()` override, no duplicated lifecycle — composites use the same BaseNode `tick()` wrapper as every other node.

**Sequence behavior:**

```
execute(context):
  // Resolve strategy if needed (see Section 4)

  for each child in committed order:
    if child is non-reactive AND completedMap.has(child):
      status = completedMap.get(child)
    else:
      status = await child.tick(context)
      if child is non-reactive AND status != RUNNING:
        completedMap.set(child, status)

    if status == FAILURE:
      this.abortAllChildControllers()
      completedMap.clear()
      return FAILURE

    if status == RUNNING:
      return RUNNING

  completedMap.clear()
  return SUCCESS
```

**Selector behavior:**

```
execute(context):
  for each child in committed order:
    if child is non-reactive AND completedMap.has(child):
      status = completedMap.get(child)
    else:
      status = await child.tick(context)
      if child is non-reactive AND status != RUNNING:
        completedMap.set(child, status)

    if status == SUCCESS:
      this.abortAllChildControllers()
      completedMap.clear()
      return SUCCESS

    if status == RUNNING:
      // Don't try lower-priority branches
      return RUNNING

    // status == FAILURE: try next child

  completedMap.clear()
  return FAILURE
```

Higher-priority branches are always re-checked. If branch 1 was FAILURE and branch 3 was RUNNING, but now branch 1 succeeds, branch 3 is aborted and the selector returns SUCCESS.

**Abort on cycle end:** When a composite short-circuits or completes a cycle, it aborts all child controllers unconditionally. Leaf nodes without inflight state ignore the signal. This eliminates the need to track which children are RUNNING — zero bookkeeping, same behavior.

**Interaction with non-blocking nodes:** When a reactive composite ticks a RUNNING child (e.g., an AgentNode mid-API-call), that child's `tick()` hits the poll path in the leaf's `execute()` — checks if the in-flight promise settled, returns RUNNING or the final status. This is fast and non-blocking.

### 3. Cycle-Based Completion Tracking

A "cycle" is the span from when a composite begins working through its children until it returns a terminal status (SUCCESS or FAILURE). Across multiple ticks where the composite returns RUNNING, you're in the same cycle. When it returns SUCCESS or FAILURE, the cycle ends. Next time the composite is ticked, a new cycle begins — cached completions are cleared.

**The re-execution problem:** In a reactive sequence `[Condition, Action, AgentNode]`, every tick re-evaluates from the start. Re-checking the Condition is the whole point. But if Action already succeeded, re-ticking it would re-execute it — wrong for side-effectful actions.

**Solution:** Composites maintain a `Map<BTreeNode, NodeStatus>` (reference equality) of children that have reached a terminal status (SUCCESS or FAILURE) during the current cycle:

- **ConditionNodes** are always re-ticked. They're stateless checks — this is the purpose of reactivity.
- **Other nodes** (actions, agents, decorators, sub-composites) that returned SUCCESS or FAILURE in this cycle return their cached result without re-executing. This matches traditional reactive BT semantics: a failed side-effectful action stays failed for the cycle rather than re-executing every tick.
- **RUNNING nodes** are ticked (polled) normally.

**How composites identify reactive (re-evaluable) nodes:** A helper function uses `instanceof` checks, recursing through single-child decorators to find the leaf:

```typescript
function isReactiveNode(node: BTreeNode): boolean {
  if (node instanceof ConditionNode) return true;
  if (node instanceof DecoratorNode) return isReactiveNode(node.child);
  return false;
}
```

This handles `Inverter(Condition)`, `AlwaysSucceed(Guard(Condition))`, etc. No interface changes required. If custom-node opt-in is ever needed, a static class property (`static reactive = true`) checked via duck-typing is sufficient — no need to add a property to the `BTreeNode` interface that every node must implement.

**Cycle lifecycle:**

- **Start:** Composite is ticked with no active cycle (fresh, or after previous cycle ended). Completion map is empty.
- **During:** Each tick re-evaluates from the start. Conditions re-checked, completed non-conditions return their cached status, RUNNING nodes polled.
- **End:** Composite returns SUCCESS or FAILURE. Completion map cleared.
- **Abort:** Composite aborted mid-cycle — completion map cleared, in-flight children aborted.

**Nested composites:** A child that is itself a Sequence manages its own cycle independently. The parent sees it as a node that returned SUCCESS, FAILURE, or RUNNING. If the parent caches the child composite's SUCCESS, the child's internal cycle state is irrelevant.

**Example:**

```
Tick 1: Cond -> SUCCESS, Action starts -> RUNNING.    Sequence -> RUNNING.  (cycle started)
Tick 2: Cond -> SUCCESS, Action polls  -> SUCCESS.    Agent starts -> RUNNING. Sequence -> RUNNING. (same cycle, Action cached)
Tick 3: Cond -> FAILURE. Agent aborted.               Sequence -> FAILURE. (cycle ended, cache cleared)
Tick 4: Cond -> SUCCESS. Action re-executes.           (new cycle)
```

### 4. Strategy Handling

The strategy interface changes from `Promise<BTreeNode[]>` to `BTreeNode[] | Promise<BTreeNode[]>`. Default strategies return synchronously (drop their `async` keyword). This eliminates the microtask penalty on every cycle start — the common case is zero-cost.

**Lifecycle** (inside the composite's `execute()`, before child traversal):

```
if (committedOrder === null):
  committedOrder = await strategy.orderChildren(children, context)

// Tick children in committed order (reactive traversal)
```

That's it. No `strategyPending`, no `strategyResult`, no cross-tick state machine. For default strategies (synchronous), the `await` is a no-op on a plain array — `execute()` continues immediately. For agent strategies (async), the `await` blocks that one tick while the SDK call completes. One slow tick at cycle start is acceptable since it only happens once per cycle.

**Committed order reset:** Same as current model — the order stays locked for the duration of a cycle. Reactive re-evaluation re-ticks children in the same committed order. The strategy is only re-consulted when a new cycle begins.

**`evaluatePolicy` for Parallel:** Same pattern — return type changes to `NodeStatus | Promise<NodeStatus>`. Default policies return synchronously. Async policies block one tick.

### 5. Abort and Cleanup on Preemption

When a reactive composite determines that a RUNNING subtree should be preempted (upstream condition failed, higher-priority branch succeeded), it aborts that subtree.

**Abort flow:**

1. Composite detects preemption condition.
2. Calls `abort()` on scoped child controllers — signal fires, leaf nodes cancel in-flight work.
3. Composite returns FAILURE or tries the next branch (depending on type).

**Leaf node abort():** ActionNode and AgentNode clear `_inflightState` to `null` on `abort()`. BaseNode.abort() remains a no-op — only nodes with inflight state need cleanup.

**Scoped AbortControllers for hard cancellation:** Composites create a scoped `AbortController` per child, stored as instance state for the duration of the cycle. The scoped controller's signal is passed to the child via `context.signal`, replacing the parent signal. The parent signal is bridged to the scoped controller so tree-wide abort still cascades:

```typescript
// Composite setup per child (once per cycle, reused across ticks)
const childController = new AbortController();
context.signal.addEventListener('abort', () => childController.abort());
const childContext = { ...context, signal: childController.signal };
```

On preemption, the composite calls `childController.abort()` — the scoped signal fires, and AgentNode's existing bridge (`context.signal → activeAbortController`) cancels the SDK call. On tree-wide abort, the parent signal fires, the bridge cascades to the scoped controller, and the same cancellation path executes. AgentNode sees one signal with two triggers — no changes needed to its bridging logic.

Controllers persist across ticks within a cycle (the child's inflight work references the signal established on the first tick). On cycle end, all child controllers are aborted (unconditional abort) and cleared. New cycle creates fresh controllers.

**Two-level abort model:**
- **Tree-wide:** `BehaviorTree.abort()` fires the tree-level signal, cascading through all scoped controllers to all nodes. Used for shutdown.
- **Subtree preemption:** Composite fires one child's scoped controller. Only that subtree is cancelled. Other children continue undisturbed. Used for reactive re-routing.

**No reset between ticks.** State persists across the tick loop. Cleanup happens surgically — only preempted subtrees get aborted. Non-preempted RUNNING nodes continue undisturbed.

**No recovery on abort.** The SDK call is cancelled, partial work is lost. If the tree routes back to that agent later, it starts fresh.

### 6. `BehaviorTree.start()` API

The tree gains a `start()` method that delegates to `TreeScheduler` with reactive-friendly defaults. This avoids duplicating interval management — TreeScheduler already handles interval ticking.

```typescript
// Start ticking every second
const handle = tree.start({ intervalMs: 1000 });

// Stop the loop
handle.stop();

// Or with an AbortSignal
const ac = new AbortController();
tree.start({ intervalMs: 1000, signal: ac.signal });
ac.abort(); // stops the loop
```

**Implementation:** `start()` creates a `TreeScheduler` with:

```typescript
new TreeScheduler(tree, {
  type: 'interval',
  delayMs: intervalMs,
  resetBetweenTicks: false,  // preserve RUNNING state across ticks
  skipOnOverlap: true,       // NEW: skip tick if previous is still running
  abortOnStop: true,         // NEW: call tree.abort() when scheduler stops
});
```

**TreeScheduler additions:**

- **`skipOnOverlap: boolean`** (default `false`) — When `true`, if the previous tick hasn't completed when the next interval fires, skip the tick and emit a `tree:tick:skipped` event (payload: `{ timestamp: number }`). When `false`, current behavior (wait for tick to complete before starting the next delay).
- **`abortOnStop: boolean`** (default `false`) — When `true`, calls `tree.abort()` on `stop()` to clean up in-flight work. When `false`, current behavior (stop scheduling without aborting).

These are small, backwards-compatible additions to TreeScheduler. Existing scheduler usage is unaffected.

**Stop conditions** are handled in userland via event listeners:

```typescript
tree.events.on('tree:tick', ({ status }) => {
  if (status === NodeStatus.SUCCESS) handle.stop();
});
```

**Existing `run()` method** remains unchanged (single tick, returns `{ status, blackboard }`).

Calling `start()` while a loop is already running throws an error.

### 7. Impact on Existing Nodes

**ConditionNode** — No changes. Stateless, fast. Always re-evaluated by reactive composites.

**ActionNode** — Add inflight state management to `execute()`. First tick starts the action and returns RUNNING; subsequent ticks poll for completion. Add `abort()` and `reset()` overrides to clear inflight state.

**AgentNode** — Same inflight pattern as ActionNode. The SDK call runs in the background. Abort wiring already exists (`activeAbortController`). Streaming events continue to fire while RUNNING. Cache behavior (`cache: true`) continues to work but is less relevant since composites handle cycle-based caching.

**Decorators:**

- **Timeout** — Must be restructured. The current `Promise.race(child.tick(), timer)` pattern breaks: under the new model, `child.tick()` returns RUNNING quickly, so the race resolves before the timer fires. Instead, Timeout should track wall-clock time across ticks using instance state:
  - On first tick: record `this._startTime = Date.now()`, tick child.
  - On each subsequent tick: check `Date.now() - this._startTime > timeoutMs`. If expired, abort child, return FAILURE. Otherwise, tick child and return its status.
  - On reset: clear `_startTime`.
- **Retry/Repeat** — Small change: persist the attempt/iteration counter as an instance field (`this._attempt` / `this._iteration`) instead of a loop-local variable. Clear in `reset()`. The loop structure in `execute()` is otherwise unchanged — when the child returns RUNNING, the loop exits early and the counter is preserved for the next tick.
- **Guard** — Already re-checks its condition on every call to `execute()`. Under the current blocking model this re-check never happens because `execute()` blocks until the child resolves. Under the new model, the child returns RUNNING quickly, so `execute()` returns quickly and is called again on the next tick — naturally re-checking the condition. The one code change needed: Guard must call `this.child.abort()` when the condition fails while the child has in-flight work, before returning FAILURE.
- **Inverter, AlwaysSucceed, AlwaysFail** — Pass through child status (inverting/overriding as appropriate). No changes needed. RUNNING passes through unchanged.

**ParallelNode** — Its `execute()` uses `Promise.all(children.map(c => c.tick(context)))`, which resolves quickly since all child ticks return fast (poll path or immediate conditions). Parallel also needs cycle-based completion tracking: children that returned SUCCESS in the current cycle should not be re-executed on subsequent ticks. The same `isReactiveNode()` check applies — reactive children (conditions, possibly decorated) are re-ticked, non-reactive children (actions, agents) return their cached result.

### 8. Type and Interface Changes

The following changes to `src/types.ts` are required:

**`TreeEvents` interface:** Add new event.

```typescript
'tree:tick:skipped': { timestamp: number };
```

**Strategy interfaces:** `orderChildren()` return type changes from `Promise<BTreeNode[]>` to `BTreeNode[] | Promise<BTreeNode[]>`. `evaluatePolicy()` return type changes from `Promise<NodeStatus>` to `NodeStatus | Promise<NodeStatus>`. Default strategies drop their `async` keyword.

**`ActionNode`:** Add `_inflightState: { promise, result?, error? } | null` field. Override `abort()` and `reset()` to set it to `null`.

**`AgentNode`:** Same `_inflightState` field as ActionNode.

**`TreeSchedulerConfig`:** Add optional fields `skipOnOverlap?: boolean` and `abortOnStop?: boolean`.

**`BehaviorTree`:** Add `start(options: { intervalMs: number; signal?: AbortSignal }): TickLoopHandle`. Internally creates a `TreeScheduler`. Returns the scheduler's existing stop handle.

Calling `start()` while a loop is already running throws an error.

### 9. Testing Strategy

**Multi-tick test pattern:**

```typescript
const status1 = await tree.tick(context);
expect(status1).toBe(NodeStatus.RUNNING);

// Simulate external blackboard change
context.blackboard.set('approved', false);

const status2 = await tree.tick(context);
expect(status2).toBe(NodeStatus.FAILURE);
```

Tests call `tick()` manually without using `start()`. No new test infrastructure required.

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
- Abort cleans up in-flight promises on leaf nodes
- Cycle cache clears when cycle ends (SUCCESS/FAILURE)
- Nested composites manage independent cycles
- `tree.start()` tick loop: interval timing, skip-on-overlap, clean shutdown
- Synchronous strategies resolve without extra ticks
- Async strategies (agent) block one tick at cycle start
- Guard aborts child when condition fails mid-execution
- Parallel completion tracking prevents re-execution of side-effectful children
- Retry/Repeat track attempts across ticks via instance state
- Timeout measures wall-clock time across ticks

**Existing tests:** Most current unit and integration tests should continue to pass since single-tick execution is a degenerate case (all nodes resolve immediately). Tests asserting specific `runningChildId` behavior will need updating since that mechanism is replaced by reactive re-evaluation with cycle-based caching. Tests for ActionNode behavior change: actions now always return RUNNING on first tick, settling on the second.
