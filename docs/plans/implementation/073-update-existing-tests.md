# Task 73: Update Existing Tests for Reactive Behavior

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update existing unit and integration tests that break due to the reactive model changes. The primary behavioral shift: ActionNode now always returns RUNNING on first tick (settling on the second), and composites no longer track `runningChildId`.

**Architecture:** No new code. Test-only changes to align expectations with the new execution model.

**Tech Stack:** TypeScript, vitest

**Spec Reference:** `docs/superpowers/specs/2026-03-13-reactive-tick-model-design.md` — Section 9

**Dependencies:** Tasks 62–70 (all node implementations)

---

### Step 1: Run all tests and collect failures

Run: `npm run test`
Collect the full list of failing tests.

### Step 2: Categorize failures

Group failures by root cause:

1. **ActionNode first-tick RUNNING** — Tests that expect an ActionNode to return SUCCESS/FAILURE on the first tick. Fix: add a second tick call, or use a resolved deferred promise in the test setup.
2. **runningChildId removal** — Tests that assert `runningChildId` on composites. Fix: remove those assertions or replace with completedMap-based checks.
3. **Blocking decorator assumptions** — Tests for Timeout/Retry/Repeat that assume `execute()` blocks until the child fully completes. Fix: use multi-tick patterns with deferred promises.
4. **Guard abort** — Tests that don't expect `abort()` to be called on condition failure. Fix: update spy expectations.
5. **Strategy sync return** — Tests that mock strategies returning `Promise<BTreeNode[]>`. Fix: return plain arrays for default strategy mocks.

### Step 3: Fix failing tests

Update each failing test file. For each test:
- Preserve the intent of what the test is verifying
- Adapt the mechanism to the new execution model
- Use deferred promises where multi-tick behavior needs to be controlled

### Step 4: Run all tests to verify they pass

Run: `npm run test`
Expected: PASS — all unit and integration tests green

### Step 5: Commit

```bash
git add -u
git commit -m "test: update existing tests for reactive tick model"
```
