# Task 72: BehaviorTree.start() Thin Wrapper

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `start()` method to BehaviorTree that creates a TreeScheduler with reactive-friendly defaults and returns a handle for stopping the loop.

**Architecture:** `start()` constructs a `TreeScheduler` with `{ type: 'interval', delayMs: intervalMs, resetBetweenTicks: false, skipOnOverlap: true, abortOnStop: true }` and calls `scheduler.start()`. Returns a `TickLoopHandle` with a `stop()` method. Throws if called while a loop is already running.

**Tech Stack:** TypeScript, vitest

**Spec Reference:** `docs/superpowers/specs/2026-03-13-reactive-tick-model-design.md` — Section 6

**Dependencies:** Task 71 (TreeScheduler skipOnOverlap + abortOnStop)

---

### Step 1: Write failing tests

Add tests to `src/core/behavior-tree.test.ts`:

- `start()` ticks the tree on the configured interval
- `start()` returns a handle with `stop()` that stops the loop
- `start()` throws if called while already running
- `start()` uses `resetBetweenTicks: false` (state preserved across ticks)
- `start()` uses `skipOnOverlap: true` (overlapping ticks skipped)
- `start()` uses `abortOnStop: true` (in-flight work aborted on stop)
- `start({ signal })` stops the loop when the signal is aborted
- After `stop()`, `start()` can be called again

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/core/behavior-tree.test.ts`
Expected: FAIL — `start()` method does not exist

### Step 3: Implement BehaviorTree.start()

Modify `src/core/behavior-tree.ts`:
- Add `private _scheduler: TreeScheduler | null = null`
- Add `start(options: { intervalMs: number; signal?: AbortSignal }): TickLoopHandle`:
  - Throw if `_scheduler` is not null and is running
  - Create `TreeScheduler` with the reactive defaults
  - If `signal` provided, wire `signal.addEventListener('abort', () => handle.stop())`
  - Call `scheduler.start()` (fire-and-forget, the promise resolves when stopped)
  - Return `{ stop: () => scheduler.stop() }` (also sets `_scheduler = null` after stop)
- Add `TickLoopHandle` type: `{ stop(): Promise<void> }`

Modify `src/types.ts`:
- Add `TickLoopHandle` type export if not already covered by Task 61

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/core/behavior-tree.test.ts`
Expected: PASS

### Step 5: Commit

```bash
git add src/core/behavior-tree.ts src/core/behavior-tree.test.ts src/types.ts
git commit -m "feat: add BehaviorTree.start() for reactive tick loop"
```
