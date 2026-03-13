# Task 69: Retry/Repeat Decorator Instance Fields

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist attempt/iteration counters as instance fields so they survive across ticks when a child returns RUNNING. Currently these are loop-local variables inside `execute()`, which means the counter resets every tick.

**Architecture:** Small change. `RetryNode` gains `private _attempt = 0`. `RepeatNode` gains `private _iteration = 0`. When the child returns RUNNING, `execute()` returns RUNNING and the counter is preserved for the next tick. When the child completes (SUCCESS/FAILURE per the decorator's logic), the counter resets. `reset()` clears the counter.

**Tech Stack:** TypeScript, vitest

**Spec Reference:** `docs/superpowers/specs/2026-03-13-reactive-tick-model-design.md` — Section 7

**Dependencies:** Task 62 (ActionNode inflight)

---

### Step 1: Write failing tests

Add tests to `src/decorators/retry.test.ts`:

- Attempt counter persists across ticks when child returns RUNNING
- After child resolves from RUNNING, retry continues from the correct attempt count
- `reset()` clears the attempt counter
- Attempt counter resets when retry sequence completes (all attempts exhausted or non-FAILURE result)

Add tests to `src/decorators/repeat.test.ts`:

- Iteration counter persists across ticks when child returns RUNNING
- After child resolves from RUNNING, repeat continues from the correct iteration count
- `reset()` clears the iteration counter
- Iteration counter resets when repeat sequence completes

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/decorators/retry.test.ts src/decorators/repeat.test.ts`
Expected: FAIL — counters currently reset every tick

### Step 3: Implement instance field counters

Modify `src/decorators/retry.ts`:
- Add `private _attempt = 0`
- Rewrite `execute()`: on entry, start from `_attempt`. On RUNNING, save `_attempt` and return. On completion (non-FAILURE or attempts exhausted), reset `_attempt = 0`
- `reset()`: set `_attempt = 0`, call `this.child.reset()`

Modify `src/decorators/repeat.ts`:
- Add `private _iteration = 0`
- Rewrite `execute()`: on entry, start from `_iteration`. On RUNNING, save `_iteration` and return. On completion (iterations finished or `untilStatus` match), reset `_iteration = 0`
- `reset()`: set `_iteration = 0`, call `this.child.reset()`

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/decorators/retry.test.ts src/decorators/repeat.test.ts`
Expected: PASS

### Step 5: Commit

```bash
git add src/decorators/retry.ts src/decorators/repeat.ts src/decorators/retry.test.ts src/decorators/repeat.test.ts
git commit -m "feat: persist retry/repeat counters as instance fields across ticks"
```
