# Task 109: Exports + Integration Verification

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Export new session types from the package, verify all tests pass and types check across the monorepo, and clean up any stale imports.

**Depends on:** Tasks 102–108

**Spec Reference:** `docs/superpowers/specs/2026-03-23-agent-sessions-design.md`

---

### Step 1: Update package exports

Check the main export file for the cartographer package (likely `src/index.ts` or the `exports` field in `package.json`). Add exports for the new public types:

- `SessionRegistry` from `./core/session-registry.js`
- `SessionConfig` from `./types.js`
- `AgentSessionOptions` from `./agent/agent.js`

Look at how existing types are exported (e.g., `Blackboard`, `TreeContext`, `AgentNode`) and follow the same pattern.

### Step 2: Verify AsyncQueue removal

Ensure no remaining imports reference `async-queue.js`:

Run: `grep -r "async-queue" packages/cartographer/src/`

Expected: No results (or only this task file if it's in the tree).

If any stale imports remain, remove them.

### Step 3: Run full monorepo test suite

Run: `pnpm test`

Expected: All tests pass across all packages (cartographer, client, react, svelte).

### Step 4: Run full typecheck

Run: `pnpm typecheck`

Expected: Clean — no type errors.

### Step 5: Run integration tests

Run: `pnpm test:integration`

Expected: All pass. Integration tests exercise the full tree lifecycle and should work with the refactored ClaudeSDKAgent.

### Step 6: Build

Run: `pnpm build`

Expected: Clean build.

### Step 7: Commit

```bash
git add packages/cartographer/src/
git commit -m "feat(cartographer): export session types and verify integration"
```
