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
  if (this._inflight):
    if (this._inflightResult !== undefined):
      result = this._inflightResult
      clear inflight state
      return result
    else:
      return RUNNING

  // Start: kick off the action, return RUNNING immediately
  this._inflight = this.action(context)
  this._inflight.then(
    status => this._inflightResult = status,
    error  => this._inflightError = error
  )
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
    if child is non-reactive AND child completed in this cycle:
      status = cached result
    else:
      status = await child.tick(context)

    if status == FAILURE:
      abort any previously-RUNNING children not yet visited
      clear cycle state
      return FAILURE

    if status == RUNNING:
      return RUNNING

    if status == SUCCESS AND child is non-reactive:
      cache child completion

  clear cycle state
  return SUCCESS
```

**Selector behavior:**

```
execute(context):
  for each child in committed order:
    if child is non-reactive AND child completed in this cycle:
      status = cached result
    else:
      status = await child.tick(context)

    if status == SUCCESS:
      abort any previously-RUNNING children not yet visited
      clear cycle state
      return SUCCESS

    if status == RUNNING:
      // Don't try lower-priority branches
      return RUNNING

    // status == FAILURE: try next child

  clear cycle state
  return FAILURE
```

Higher-priority branches are always re-checked. If branch 1 was FAILURE and branch 3 was RUNNING, but now branch 1 succeeds, branch 3 is aborted and the selector returns SUCCESS.

**Aborting previously-RUNNING children:** When a composite short-circuits (e.g., condition fails at index 2, but child at index 4 was RUNNING from a previous tick), it must abort children that have in-flight state but were not visited in this tick. The composite tracks which children are currently RUNNING (those that returned RUNNING on any tick in this cycle) and calls `abort()` on any that need cleanup when the cycle ends or is preempted.

**Interaction with non-blocking nodes:** When a reactive composite ticks a RUNNING child (e.g., an AgentNode mid-API-call), that child's `tick()` hits the poll path in the leaf's `execute()` — checks if the in-flight promise settled, returns RUNNING or the final status. This is fast and non-blocking.

### 3. Cycle-Based Completion Tracking

A "cycle" is the span from when a composite begins working through its children until it returns a terminal status (SUCCESS or FAILURE). Across multiple ticks where the composite returns RUNNING, you're in the same cycle. When it returns SUCCESS or FAILURE, the cycle ends. Next time the composite is ticked, a new cycle begins — cached completions are cleared.

**The re-execution problem:** In a reactive sequence `[Condition, Action, AgentNode]`, every tick re-evaluates from the start. Re-checking the Condition is the whole point. But if Action already succeeded, re-ticking it would re-execute it — wrong for side-effectful actions.

**Solution:** Composites track which children have completed (SUCCESS) during the current cycle:

- **ConditionNodes** are always re-ticked. They're stateless checks — this is the purpose of reactivity.
- **Other nodes** (actions, agents, decorators, sub-composites) that returned SUCCESS in this cycle return their cached result without re-executing.
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

Strategy calls get the same non-blocking treatment as leaf node execution. Composites handle pending strategy calls as instance state, returning RUNNING until the strategy resolves.

**Lifecycle** (inside the composite's `execute()`, before child traversal):

```
// Phase 1: Strategy resolution (instance state on the composite)
if (strategyPending):
  if (strategyResult settled):
    committedOrder = strategyResult
    clear strategyPending
  else:
    return RUNNING

if (committedOrder === null):
  promise = strategy.orderChildren(children, context)
  // Store as pending — check on next tick
  strategyPending = promise
  promise.then(r => strategyResult = r)
  return RUNNING

// Phase 2: Tick children in committed order (reactive traversal)
```

Note: This means even fast/synchronous strategies take one tick to resolve (the `.then()` callback fires as a microtask, after `execute()` has already returned RUNNING). This is consistent with how ActionNode works — one extra tick for the common case, in exchange for a single simple code path.

**Committed order reset:** Same as current model — the order stays locked for the duration of a cycle. Reactive re-evaluation re-ticks children in the same committed order. The strategy is only re-consulted when a new cycle begins.

**`evaluatePolicy` for Parallel:** Same pattern. If policy evaluation is async, Parallel stores the pending promise and returns RUNNING until it resolves.

### 5. Abort and Cleanup on Preemption

When a reactive composite determines that a RUNNING subtree should be preempted (upstream condition failed, higher-priority branch succeeded), it aborts that subtree.

**Abort flow:**

1. Composite detects preemption condition.
2. Calls `abort()` on preempted children (cascades through the subtree).
3. In-flight promises are abandoned (results, if they arrive later, are ignored).
4. Composite returns FAILURE or tries the next branch (depending on type).

**Leaf node abort():** ActionNode and AgentNode clear their inflight state (`_inflight`, `_inflightResult`) on `abort()`. BaseNode.abort() remains a no-op — only nodes with inflight state need cleanup.

**AbortSignal scoping:** The tree shares a single `AbortController` whose signal is passed to all nodes via `context.signal`. Subtree preemption does NOT use this tree-level signal (aborting one subtree should not abort the whole tree). Instead, `abort()` is best-effort: the in-flight promise is abandoned (cleared from tracking, results ignored if they arrive later), but the underlying async work may continue running until it naturally completes or checks `context.signal`. Nodes that need hard cancellation (like `AgentNode`) already create their own `AbortController` and bridge it to the context signal — this pattern continues to work.

**No reset between ticks.** State persists across the tick loop. Cleanup happens surgically — only preempted subtrees get aborted. Non-preempted RUNNING nodes continue undisturbed.

**Abort during strategy resolution:** If a composite is waiting on a strategy call and gets aborted by a parent, the composite's `abort()` clears the pending strategy promise (in addition to aborting children). Strategies have no side effects to roll back.

**No recovery on abort.** The SDK call is cancelled, partial work is lost. If the tree routes back to that agent later, it starts fresh.

### 6. `BehaviorTree.start()` API

The tree gains a `start()` method that starts a fixed-interval tick loop. (The existing `run()` method — which ticks once and returns a status/blackboard snapshot — is unchanged.)

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

**Behavior:**

- Ticks immediately on start (no initial delay), then every `intervalMs`.
- If a tick is still in progress when the next interval fires, skip that tick. Ticks should be fast (polling and condition checks), so this is a safeguard.
- No reset between ticks — state persists.
- On `stop()`: cancels the interval, calls `tree.abort()` to clean up in-flight work.

**Events:**

- Existing `tree:tick` fires after each tick with status and duration.
- New `tree:tick:skipped` event (payload: `{ timestamp: number }`) when a tick is skipped due to overlap.

**Stop conditions** are handled in userland via event listeners:

```typescript
tree.events.on('tree:tick', ({ status }) => {
  if (status === NodeStatus.SUCCESS) handle.stop();
});
```

**Existing `run()` method** remains unchanged (single tick, returns `{ status, blackboard }`). **Existing scheduler** remains unchanged for cron and one-shot use cases.

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
- **Retry/Repeat** — Must be restructured to use instance state. The current `for` loop with local counter variables doesn't survive across ticks. Instead:
  - Store attempt/iteration count as instance fields (e.g., `this._attempt`).
  - On each tick: tick the child. If child is RUNNING, return RUNNING. If child failed and attempts remain, increment `this._attempt`, reset the child, and return RUNNING (next tick starts the retry). If all attempts exhausted, return FAILURE.
  - `execute()` does one unit of work per tick and returns immediately.
  - On reset: clear attempt/iteration state.
- **Guard** — Already re-checks its condition on every call to `execute()`. Under the current blocking model this re-check never happens because `execute()` blocks until the child resolves. Under the new model, the child returns RUNNING quickly, so `execute()` returns quickly and is called again on the next tick — naturally re-checking the condition. The one code change needed: Guard must call `this.child.abort()` when the condition fails while the child has in-flight work, before returning FAILURE.
- **Inverter, AlwaysSucceed, AlwaysFail** — Pass through child status (inverting/overriding as appropriate). No changes needed. RUNNING passes through unchanged.

**ParallelNode** — Its `execute()` uses `Promise.all(children.map(c => c.tick(context)))`, which resolves quickly since all child ticks return fast (poll path or immediate conditions). Parallel also needs cycle-based completion tracking: children that returned SUCCESS in the current cycle should not be re-executed on subsequent ticks. The same `isReactiveNode()` check applies — reactive children (conditions, possibly decorated) are re-ticked, non-reactive children (actions, agents) return their cached result.

### 8. Type and Interface Changes

The following changes to `src/types.ts` are required:

**`TreeEvents` interface:** Add new event.

```typescript
'tree:tick:skipped': { timestamp: number };
```

**`ActionNode`:** Add `_inflight`, `_inflightResult`, `_inflightError` fields. Override `abort()` and `reset()` to clear them.

**`AgentNode`:** Same inflight fields as ActionNode.

**`BehaviorTree`:** Add `start(options: { intervalMs: number; signal?: AbortSignal }): TickLoopHandle`.

```typescript
interface TickLoopHandle {
  stop(): void;
}
```

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
- Strategy resolution across ticks (pending -> resolved)
- Guard aborts child when condition fails mid-execution
- Parallel completion tracking prevents re-execution of side-effectful children
- Retry/Repeat track attempts across ticks via instance state
- Timeout measures wall-clock time across ticks

**Existing tests:** Most current unit and integration tests should continue to pass since single-tick execution is a degenerate case (all nodes resolve immediately). Tests asserting specific `runningChildId` behavior will need updating since that mechanism is replaced by reactive re-evaluation with cycle-based caching. Tests for ActionNode behavior change: actions now always return RUNNING on first tick, settling on the second.
