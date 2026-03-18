# Task 125: Implement useAction

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the `useAction` hook for sending actions to the tree with pending state tracking.

**Depends on:** Task 122 (provider and context)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md` — useAction section

**Approach:** TDD — write failing tests first, then minimal implementation.

---

### Step 1: RED — Write failing tests

Add to `packages/react/src/hooks.test.tsx`:

**send() tests:**
- `send()` calls `client.action(name, payload)` with correct arguments
- `send()` resolves with `{ id }` from the client
- `pending` is `false` initially
- `pending` becomes `true` after `send()` resolves
- `pending` becomes `false` when `message:processed` SSE event arrives with matching message ID
- `pending` becomes `false` when `message:failed` SSE event arrives with matching message ID
- `pending` does NOT change when `message:processed` arrives with a different message ID

**sendAndWait() tests:**
- `sendAndWait()` calls `client.actionAndWait(name, payload)`
- `pending` is `true` during `sendAndWait()` and `false` after it resolves
- `pending` is `false` after `sendAndWait()` rejects

**Error tests:**
- `send()` propagates `ConflictError` when `client.action()` rejects with 409

### Step 2: Verify RED

Run: `npx vitest run packages/react/src/hooks.test.tsx`

### Step 3: GREEN — Implement useAction

Add to `packages/react/src/hooks.ts`:

- Uses `useState` for `pending`
- Uses `useRef` to track the pending message ID
- Uses `useEffect` to register `message:processed` and `message:failed` listeners on the client for clearing `pending`
- `send()` calls `client.action()`, stores the returned ID, sets `pending = true`
- `sendAndWait()` sets `pending = true`, calls `client.actionAndWait()`, sets `pending = false` in `finally`

### Step 4: Verify GREEN

Run: `npx vitest run packages/react/src/hooks.test.tsx` — action tests pass.

### Step 5: Update exports and commit

Add `useAction` to `packages/react/src/index.ts`.

```bash
git add packages/react/src/
git commit -m "feat(react): implement useAction hook with pending state tracking"
```
