# Task 71: TreeScheduler skipOnOverlap and abortOnStop

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add two new options to TreeScheduler: `skipOnOverlap` (skip tick if previous is still running) and `abortOnStop` (call `tree.abort()` when scheduler stops). These support the reactive tick loop where ticks may overlap and clean shutdown requires aborting in-flight work.

**Architecture:** Small, backwards-compatible additions. `skipOnOverlap` requires tracking whether a tick is currently executing. When the next interval fires and a tick is still in progress, skip it and emit `tree:tick:skipped`. `abortOnStop` adds a `tree.abort()` call in the `stop()` method.

**Tech Stack:** TypeScript, vitest

**Spec Reference:** `docs/superpowers/specs/2026-03-13-reactive-tick-model-design.md` — Section 6

**Dependencies:** Task 61 (type changes for `TreeSchedulerConfig` and `tree:tick:skipped` event)

---

### Step 1: Write failing tests

Add tests to `src/scheduler/tree-scheduler.test.ts`:

**skipOnOverlap tests:**
- When `skipOnOverlap: true` and previous tick is still running, next tick is skipped
- Skipped tick emits `tree:tick:skipped` event with timestamp
- When `skipOnOverlap: false` (default), ticks wait for previous to complete (existing behavior)
- After skipped tick, next interval fires normally and ticks if previous has completed

**abortOnStop tests:**
- When `abortOnStop: true`, calling `stop()` invokes `tree.abort()`
- When `abortOnStop: false` (default), calling `stop()` does not invoke `tree.abort()` (existing behavior)
- `abortOnStop` fires before the scheduler fully stops

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/scheduler/tree-scheduler.test.ts`
Expected: FAIL — options not recognized

### Step 3: Implement skipOnOverlap and abortOnStop

Modify `src/scheduler/tree-scheduler.ts`:

**skipOnOverlap:**
- Add `private _tickInProgress = false` flag
- In `executeTick()`: set `_tickInProgress = true` at start, `false` at end (in `finally`)
- In `runInterval()`: before calling `executeTick()`, check `_tickInProgress`. If `true` and `skipOnOverlap` is enabled, emit `tree:tick:skipped` event and continue to next interval without ticking

**abortOnStop:**
- In `stop()`: if `abortOnStop` is `true`, call `this.config.tree.abort()` before emitting `scheduler:stop`

**Note:** The `tree:tick:skipped` event type and `SchedulerConfig` type additions (`skipOnOverlap`, `abortOnStop`) are added in Task 61. If Task 61 has not been implemented yet, add the types inline and reconcile later.

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/scheduler/tree-scheduler.test.ts`
Expected: PASS

### Step 5: Run all tests

Run: `npm run test`
Expected: PASS — changes are backwards-compatible

### Step 6: Commit

```bash
git add src/scheduler/tree-scheduler.ts src/scheduler/tree-scheduler.test.ts
git commit -m "feat: add skipOnOverlap and abortOnStop options to TreeScheduler"
```
