# Task 63: AgentNode Inflight State

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make AgentNode non-blocking using the same inflight pattern as ActionNode. First tick starts the SDK call and returns RUNNING. Subsequent ticks poll for completion.

**Architecture:** AgentNode gains the same `_inflightState` field as ActionNode. The SDK call runs in the background. Streaming events (`agent:text`, `agent:thinking`, etc.) continue to fire while RUNNING. `activeAbortController` bridging is set up on the first tick and remains active.

**Tech Stack:** TypeScript, vitest

**Spec Reference:** `docs/superpowers/specs/2026-03-13-reactive-tick-model-design.md` — Sections 1, 7

---

### Step 1: Write failing tests

Add tests to `src/nodes/agent.test.ts` for inflight behavior:

- AgentNode returns RUNNING on first tick while SDK call is in progress
- AgentNode returns SUCCESS on subsequent tick after SDK call completes
- AgentNode returns FAILURE on subsequent tick after SDK call fails
- Streaming events fire while node is RUNNING
- `abort()` clears inflight state and aborts the SDK call via activeAbortController
- `reset()` clears inflight state
- Multiple poll ticks don't re-invoke the SDK

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/nodes/agent.test.ts`
Expected: FAIL — AgentNode currently blocks until SDK call completes

### Step 3: Implement inflight state in AgentNode

Modify `src/nodes/agent.ts`:
- Add `_inflightState` field (same shape as ActionNode)
- Wrap the existing SDK call logic in a function that runs in the background
- `execute()` starts the background work on first call, polls on subsequent calls
- Ensure `activeAbortController` setup happens on the start tick
- `abort()` clears `_inflightState` (existing abort of `activeAbortController` continues to work)
- `reset()` clears `_inflightState`

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/nodes/agent.test.ts`
Expected: PASS

### Step 5: Run all tests

Run: `npm run test`
Expected: Some existing agent tests may need updating. Update affected tests.

### Step 6: Commit

```bash
git add src/nodes/agent.ts src/nodes/agent.test.ts
git commit -m "feat: make AgentNode non-blocking with inflight state management"
```
