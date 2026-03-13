# Task 68: Timeout Decorator Wall-Clock Tracking

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure TimeoutNode to track wall-clock time across ticks using instance state instead of `Promise.race`. Under the new model, `child.tick()` returns RUNNING quickly, so the race resolves before the timer fires — the current approach no longer works.

**Architecture:** TimeoutNode gains a `_startTime: number | null` field. On the first tick where the child is active, it records `Date.now()`. On each subsequent tick, it checks elapsed time against `timeoutMs`. If expired, it aborts the child and returns FAILURE. If not, it ticks the child and returns its status. `_startTime` resets when the child completes (SUCCESS/FAILURE) or on `reset()`.

**Tech Stack:** TypeScript, vitest

**Spec Reference:** `docs/superpowers/specs/2026-03-13-reactive-tick-model-design.md` — Section 7

**Dependencies:** Task 62 (ActionNode inflight)

---

### Step 1: Write failing tests

Add tests to `src/decorators/timeout.test.ts` for wall-clock tracking:

- Timeout fires after wall-clock time exceeds `timeoutMs` across multiple ticks
- Child returning RUNNING within timeout window passes through RUNNING
- Child completing before timeout returns the child's status (SUCCESS or FAILURE)
- Child aborted when timeout expires (`child.abort()` called)
- `_startTime` is set on first tick, not reset between RUNNING ticks
- `_startTime` clears when child returns terminal status (new cycle)
- `reset()` clears `_startTime`
- Timeout measured from first RUNNING tick, not from construction

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/decorators/timeout.test.ts`
Expected: FAIL — current implementation uses Promise.race

### Step 3: Implement wall-clock TimeoutNode

Rewrite `src/decorators/timeout.ts`:
- Add `private _startTime: number | null = null`
- Remove the `Promise.race` / `setTimeout` approach
- In `execute()`:
  - If `_startTime !== null` and `Date.now() - _startTime > timeoutMs`: call `this.child.abort()`, set `_startTime = null`, return FAILURE
  - Tick the child
  - If child returns RUNNING and `_startTime === null`: set `_startTime = Date.now()`
  - If child returns SUCCESS or FAILURE: set `_startTime = null`, return the status
  - If child returns RUNNING: return RUNNING
- `reset()`: set `_startTime = null`, call `this.child.reset()`
- `abort()`: set `_startTime = null`, call `this.child.abort()`

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/decorators/timeout.test.ts`
Expected: PASS

### Step 5: Run all tests

Run: `npm run test`
Expected: Update existing timeout tests as needed

### Step 6: Commit

```bash
git add src/decorators/timeout.ts src/decorators/timeout.test.ts
git commit -m "feat: restructure TimeoutNode to track wall-clock time across ticks"
```
