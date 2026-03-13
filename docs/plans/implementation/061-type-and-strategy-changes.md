# Task 61: Type and Strategy Interface Changes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update strategy interfaces to support synchronous return types, add new events to TreeEvents, and add new config options to TreeSchedulerConfig. This is the foundation task that other reactive tick tasks depend on.

**Architecture:** Strategy `order()`/`orderChildren()` return type changes from `Promise<BTreeNode[]>` to `BTreeNode[] | Promise<BTreeNode[]>`. `evaluatePolicy()` changes from `Promise<NodeStatus>` to `NodeStatus | Promise<NodeStatus>`. Default strategies drop `async`. New `tree:tick:skipped` event added to TreeEvents. TreeSchedulerConfig gets `skipOnOverlap` and `abortOnStop` fields.

**Tech Stack:** TypeScript

**Spec Reference:** `docs/superpowers/specs/2026-03-13-reactive-tick-model-design.md` — Sections 4, 8

---

### Step 1: Update strategy interfaces in types.ts

In `src/types.ts`, change strategy method return types:
- `ExecutionStrategy.order()` → `BTreeNode[] | Promise<BTreeNode[]>`
- `SelectionStrategy.order()` → `BTreeNode[] | Promise<BTreeNode[]>`
- `ParallelStrategy.policy()` → return type supports sync or async

Also add to `TreeEvents`:
```typescript
'tree:tick:skipped': { timestamp: number };
```

Also add to `TreeSchedulerConfig` (or equivalent):
```typescript
skipOnOverlap?: boolean;
abortOnStop?: boolean;
```

### Step 2: Update default strategies to drop async

In `src/strategies/default-execution.ts`, `src/strategies/default-selection.ts`, and `src/strategies/default-parallel.ts`:
- Remove `async` keyword from methods
- Return plain arrays/values instead of promises

### Step 3: Run typecheck

Run: `npm run typecheck`
Expected: PASS — all return types are compatible (sync values satisfy `T | Promise<T>`)

### Step 4: Run existing tests

Run: `npm run test`
Expected: PASS — sync return values are awaitable, so existing `await strategy.order(...)` calls work unchanged

### Step 5: Commit

```bash
git add src/types.ts src/strategies/
git commit -m "feat: update strategy interfaces to support sync returns, add reactive tick types"
```
