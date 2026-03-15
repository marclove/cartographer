# Task 67: ParallelNode Reactive Completion Tracking

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add cycle-based completion tracking to ParallelNode. Non-reactive children that returned SUCCESS or FAILURE in this cycle are not re-ticked. Reactive children (conditions) are always re-ticked.

**Architecture:** ParallelNode gains a `Map<BTreeNode, NodeStatus>` completion map and scoped AbortControllers per child. On each tick, it ticks all non-completed children concurrently via `Promise.all()`, caching results for non-reactive children. Policy evaluation uses sync-friendly return type.

**Tech Stack:** TypeScript, vitest

**Spec Reference:** `docs/superpowers/specs/2026-03-13-reactive-tick-model-design.md` — Sections 2, 3, 7

**Dependencies:** Tasks 61, 62, 64

---

### Step 1: Write failing tests

Add tests to `src/composites/parallel.test.ts`:

- Non-reactive children that completed SUCCESS are not re-ticked
- Non-reactive children that completed FAILURE are not re-ticked
- Reactive children (conditions) are re-ticked every tick
- Completion map clears when cycle ends (all children reach terminal status)
- Scoped AbortControllers per child, parent signal cascades
- RUNNING children continue to be polled via Promise.all
- `reset()` clears completion map and controllers

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/composites/parallel.test.ts`
Expected: FAIL

### Step 3: Implement reactive ParallelNode

Modify `src/composites/parallel.ts`:
- Add `_completedMap`, `_childControllers`
- In `execute()`: only tick children not in completedMap (or reactive), use `Promise.all` on the subset, cache results
- On cycle end: clear maps
- `reset()` and `abort()`: clear all state

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/composites/parallel.test.ts`
Expected: PASS

### Step 5: Commit

```bash
git add src/composites/parallel.ts src/composites/parallel.test.ts
git commit -m "feat: add cycle-based completion tracking to ParallelNode"
```
