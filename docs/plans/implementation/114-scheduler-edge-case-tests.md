# Task 114: Scheduler Edge Case Tests — `src/scheduler/tree-scheduler.ts` (82% -> ~93%)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add tests for uncovered scheduler paths: `onError` as function, cron schedule, and start/stop edge cases.

**Depends on:** None

---

### Context

`src/scheduler/tree-scheduler.ts` is at 82% coverage with 18 existing tests. The gaps are in the cron execution path, `onError` as a callback function (vs string), and start/stop idempotency.

### Files

- Modify: `src/scheduler/tree-scheduler.test.ts`
- Reference: `src/scheduler/tree-scheduler.ts` (source under test)

### Approach

Follow existing pattern using `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync()`. For `onError` as function, pass a `vi.fn()` that returns `'continue'` or `'stop'`.

---

- [ ] **Step 1: Add `onError` function tests**

- `onError` as function returning `'continue'` — tree tick throws, scheduler continues, function was called with the error
- `onError` as function returning `'stop'` — tree tick throws, scheduler stops

- [ ] **Step 2: Add cron schedule test**

- Cron schedule executes tick at next occurrence (use a simple cron like `* * * * *` for every minute, advance fake timer accordingly)
- Cron with `skipOnOverlap: true` skips when previous tick still in progress

- [ ] **Step 3: Add idempotency tests**

- `start()` when already running is a no-op (doesn't create duplicate intervals)
- `stop()` when not running resolves immediately without error

- [ ] **Step 4: Run tests and verify coverage**

```bash
npx vitest run src/scheduler/tree-scheduler.test.ts
npx vitest run --config vitest.coverage.ts 2>&1 | grep "tree-scheduler"
```

Expected: `src/scheduler/tree-scheduler.ts` coverage rises to ~93%.
