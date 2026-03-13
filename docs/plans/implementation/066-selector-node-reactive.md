# Task 66: SelectorNode Reactive Rewrite

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite SelectorNode to be reactive — re-evaluate from the first child on every tick, with cycle-based completion tracking and scoped AbortControllers. Higher-priority branches preempt lower-priority RUNNING branches.

**Architecture:** Same pattern as SequenceNode (Task 65) — `Map<BTreeNode, NodeStatus>` for completion, scoped `AbortController` per child, reactive traversal from the start on every tick. Key difference: SUCCESS short-circuits (not FAILURE), and higher-priority branch success aborts lower-priority RUNNING branches.

**Tech Stack:** TypeScript, vitest

**Spec Reference:** `docs/superpowers/specs/2026-03-13-reactive-tick-model-design.md` — Sections 2, 3, 5

**Dependencies:** Tasks 61, 62, 64

---

### Step 1: Write failing tests

Add tests to `src/composites/selector.test.ts` for reactive behavior:

- Higher-priority branches re-evaluated every tick while lower-priority child is RUNNING
- Higher-priority branch succeeding aborts lower-priority RUNNING child (via scoped controller)
- Completed non-reactive children cached within cycle (FAILURE result cached)
- RUNNING child polled on each tick without re-executing
- Cycle ends (map cleared) when selector returns SUCCESS or FAILURE
- Scoped AbortControllers: child receives scoped signal, parent cascades
- Committed order persists within a cycle
- `reset()` clears completion map and child controllers

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/composites/selector.test.ts`
Expected: FAIL

### Step 3: Implement reactive SelectorNode

Rewrite `src/composites/selector.ts` following the same pattern as SequenceNode:
- Add `_completedMap`, `_childControllers`, `_committedOrder`
- In `execute()`:
  - Resolve strategy if `_committedOrder === null`
  - For each child: check completedMap, tick with scoped context, cache result
  - If SUCCESS: abort all child controllers, clear maps, return SUCCESS
  - If RUNNING: return RUNNING (don't try lower-priority branches)
  - If FAILURE: try next child
  - All failed: clear maps, return FAILURE
- `reset()` and `abort()` clear all state
- Remove `runningChildId` tracking

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/composites/selector.test.ts`
Expected: PASS

### Step 5: Run all tests

Run: `npm run test`
Expected: Update existing tests as needed

### Step 6: Commit

```bash
git add src/composites/selector.ts src/composites/selector.test.ts
git commit -m "feat: rewrite SelectorNode with reactive re-evaluation and scoped abort"
```
