# Task 62: ActionNode Inflight State

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make ActionNode non-blocking by managing inflight state. First tick starts the action and returns RUNNING immediately. Subsequent ticks poll for completion.

**Architecture:** ActionNode gains `_inflightState: { promise: Promise<NodeStatus>; result?: NodeStatus; error?: Error } | null`. `execute()` checks this field to either poll or start new work. `abort()` and `reset()` clear it.

**Tech Stack:** TypeScript, vitest

**Spec Reference:** `docs/superpowers/specs/2026-03-13-reactive-tick-model-design.md` — Sections 1, 7

---

### Step 1: Write failing tests

Add tests to `src/nodes/action.test.ts` for inflight behavior:

- ActionNode returns RUNNING on first tick (even for fast actions)
- ActionNode returns final status on second tick after action resolves
- ActionNode returns RUNNING while action is still pending
- ActionNode handles action errors (returns FAILURE after error)
- `abort()` clears inflight state — next tick starts fresh
- `reset()` clears inflight state — next tick starts fresh
- Multiple ticks while RUNNING don't re-invoke the action function

Use deferred promises to control when actions complete:
```typescript
let resolve: (status: NodeStatus) => void;
const action = async () => new Promise<NodeStatus>(r => { resolve = r; });
```

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/nodes/action.test.ts`
Expected: FAIL — ActionNode currently blocks until action completes

### Step 3: Implement inflight state in ActionNode

Modify `src/nodes/action.ts`:
- Add `private _inflightState: { promise: Promise<NodeStatus>; result?: NodeStatus; error?: Error } | null = null`
- Rewrite `execute()` to check/poll/start pattern from spec
- Override `abort()` to set `_inflightState = null`
- Override `reset()` to call `super.reset()` and set `_inflightState = null`

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/nodes/action.test.ts`
Expected: PASS

### Step 5: Run all tests

Run: `npm run test`
Expected: Some existing tests may need updating since ActionNode now returns RUNNING on first tick instead of the final status. Update affected tests.

### Step 6: Commit

```bash
git add src/nodes/action.ts src/nodes/action.test.ts
git commit -m "feat: make ActionNode non-blocking with inflight state management"
```
