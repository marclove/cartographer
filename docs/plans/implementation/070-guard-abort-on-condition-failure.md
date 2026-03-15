# Task 70: Guard Decorator Abort on Condition Failure

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add child abort when the Guard's condition fails while the child has in-flight work. Guard already re-checks its condition on every `execute()` call — under the new non-blocking model, `execute()` is called on every tick (since the child returns RUNNING quickly). The one code change: call `this.child.abort()` before returning FAILURE when the condition fails.

**Architecture:** Minimal change. In `execute()`, when the condition returns `false` or throws, call `this.child.abort()` before returning FAILURE. This ensures that if the child has in-flight work (e.g., an ActionNode or AgentNode mid-API-call), it gets aborted rather than silently abandoned.

**Tech Stack:** TypeScript, vitest

**Spec Reference:** `docs/superpowers/specs/2026-03-13-reactive-tick-model-design.md` — Section 7

**Dependencies:** Task 62 (ActionNode inflight)

---

### Step 1: Write failing tests

Add tests to `src/decorators/guard.test.ts`:

- Guard aborts child when condition fails while child has in-flight work
- Guard aborts child when condition throws while child has in-flight work
- Guard still returns FAILURE immediately when condition fails (no behavioral change on return value)
- Child without in-flight work receives abort harmlessly (no-op)

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/decorators/guard.test.ts`
Expected: FAIL — current implementation does not call `this.child.abort()` on condition failure

### Step 3: Implement abort on condition failure

Modify `src/decorators/guard.ts`:
- In `execute()`, add `this.child.abort()` call in both code paths where the condition fails:
  - When `condition(context)` returns `false`: call `this.child.abort()` before returning FAILURE
  - When `condition(context)` throws: call `this.child.abort()` before returning FAILURE

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/decorators/guard.test.ts`
Expected: PASS

### Step 5: Commit

```bash
git add src/decorators/guard.ts src/decorators/guard.test.ts
git commit -m "feat: abort Guard child when condition fails during in-flight work"
```
