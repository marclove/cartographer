# Task 74: Reactive Integration Tests

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add multi-tick integration tests that validate the reactive model end-to-end: conditions preempting RUNNING subtrees, cycle-based caching, scoped abort, and the `start()` tick loop.

**Architecture:** New test file(s) in `src/__integration__/` that compose full trees and tick them multiple times, simulating blackboard changes between ticks.

**Tech Stack:** TypeScript, vitest

**Spec Reference:** `docs/superpowers/specs/2026-03-13-reactive-tick-model-design.md` — Section 9

**Dependencies:** Tasks 62–72 (all implementations)

---

### Step 1: Write integration tests

Create `src/__integration__/reactive-tick.test.ts`:

**Condition change mid-cycle aborts RUNNING children:**
- Sequence `[Condition, ActionNode]` where Action is RUNNING
- Between ticks, change blackboard so Condition returns FAILURE
- Verify Action was aborted and sequence returns FAILURE
- Verify next tick starts a fresh cycle (Action re-executes)

**Completed actions are not re-executed within a cycle:**
- Sequence `[Condition, Action1, Action2]` where Action1 completes SUCCESS on tick 2
- On tick 3, Action1 should not be re-ticked (cached SUCCESS)
- Condition should be re-ticked (reactive)

**Nested composites manage independent cycles:**
- Selector `[Sequence[Cond, Agent], Fallback Action]`
- Agent is RUNNING, Cond fails — inner sequence aborts Agent, returns FAILURE
- Selector tries fallback, which starts and returns RUNNING

**Higher-priority branch preemption in Selector:**
- Selector with two branches, lower branch RUNNING
- Higher branch begins succeeding — lower branch aborted, selector returns SUCCESS

**Guard aborts child on condition failure:**
- Guard wrapping an ActionNode that is RUNNING
- Condition changes to false between ticks
- Verify Action aborted and Guard returns FAILURE

**Parallel completion tracking:**
- ParallelNode with `[Condition, Action1, Action2]`
- Action1 completes, Action2 still RUNNING
- Verify Action1 not re-ticked, Condition re-ticked, Action2 polled

**Retry/Repeat across ticks:**
- RetryNode wrapping an ActionNode that returns RUNNING then FAILURE
- Verify attempt counter persists across RUNNING ticks
- Verify retry continues from correct attempt after resolution

**Timeout across ticks:**
- TimeoutNode wrapping a slow ActionNode
- Verify timeout fires based on wall-clock time across multiple ticks
- Verify child aborted on timeout

**tree.start() tick loop:**
- Start a tree with `intervalMs: 50`
- Verify multiple ticks fire
- Stop via handle, verify abort called and loop ends
- Verify `signal` option stops the loop when aborted

**Synchronous vs async strategy:**
- Tree with default strategy: verify no extra tick delay
- Tree with async agent strategy: verify one tick delay at cycle start

### Step 2: Run integration tests

Run: `npx vitest run src/__integration__/reactive-tick.test.ts`
Expected: PASS

### Step 3: Run all tests

Run: `npm run test:all`
Expected: PASS

### Step 4: Commit

```bash
git add src/__integration__/reactive-tick.test.ts
git commit -m "test: add reactive model integration tests for multi-tick scenarios"
```
