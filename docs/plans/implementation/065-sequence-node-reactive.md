# Task 65: SequenceNode Reactive Rewrite

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite SequenceNode to be reactive — re-evaluate from the first child on every tick, with cycle-based completion tracking and scoped AbortControllers for hard cancellation on preemption.

**Architecture:** SequenceNode.execute() re-evaluates children from the start on every tick. Maintains a `Map<BTreeNode, NodeStatus>` for cycle completion tracking (non-reactive children cached, conditions always re-ticked). Creates a scoped `AbortController` per child, bridged to the parent signal. On cycle end or short-circuit, aborts all child controllers unconditionally.

**Tech Stack:** TypeScript, vitest

**Spec Reference:** `docs/superpowers/specs/2026-03-13-reactive-tick-model-design.md` — Sections 2, 3, 5

**Dependencies:** Tasks 61, 62, 64

---

### Step 1: Write failing tests

Add tests to `src/composites/sequence.test.ts` for reactive behavior:

- Conditions are re-evaluated every tick while a later child is RUNNING
- Completed non-reactive children are NOT re-ticked within a cycle (completedMap)
- Completed non-reactive children ARE re-ticked in a new cycle (after cycle ends)
- Condition failure mid-cycle aborts RUNNING children (via scoped controller)
- Cycle ends (map cleared) when sequence returns SUCCESS or FAILURE
- Scoped AbortController: child receives scoped signal, not parent signal
- Scoped AbortController: parent signal cascades to scoped controller (tree-wide abort)
- Scoped AbortController: composite can abort individual child controller (preemption)
- Committed order persists within a cycle, strategy re-consulted on new cycle
- Sync strategy resolves without extra tick
- `reset()` clears completion map and child controllers

Use deferred promises for ActionNode to control tick-by-tick behavior.

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/composites/sequence.test.ts`
Expected: FAIL — current SequenceNode skips to RUNNING child, no reactive re-evaluation

### Step 3: Implement reactive SequenceNode

Rewrite `src/composites/sequence.ts`:
- Add `private _completedMap = new Map<BTreeNode, NodeStatus>()`
- Add `private _childControllers = new Map<BTreeNode, AbortController>()`
- Add `private _committedOrder: BTreeNode[] | null = null`
- In `execute()`:
  - Resolve strategy if `_committedOrder === null` (sync-friendly `await`)
  - For each child in committed order:
    - If non-reactive and in completedMap, use cached status
    - Else, create scoped AbortController if not yet created for this child in this cycle, bridge parent signal, tick child with scoped context
    - If non-reactive and status != RUNNING, add to completedMap
    - If FAILURE: abort all child controllers, clear maps, return FAILURE
    - If RUNNING: return RUNNING
  - Clear maps, return SUCCESS
- `reset()`: clear `_completedMap`, `_committedOrder`, abort and clear `_childControllers`
- `abort()`: abort all child controllers, clear maps
- Remove `runningChildId` tracking (replaced by reactive re-evaluation)

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/composites/sequence.test.ts`
Expected: PASS

### Step 5: Run all tests

Run: `npm run test`
Expected: Update any existing tests that rely on old skip-to-RUNNING-child behavior

### Step 6: Commit

```bash
git add src/composites/sequence.ts src/composites/sequence.test.ts
git commit -m "feat: rewrite SequenceNode with reactive re-evaluation and scoped abort"
```
