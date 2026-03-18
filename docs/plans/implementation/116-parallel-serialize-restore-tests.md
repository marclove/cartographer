# Task 116: Parallel Serialize/Restore Tests — `src/composites/parallel.ts` (83% -> ~93%)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add tests for serialization, restore, and signal edge cases in ParallelNode.

**Depends on:** None

---

### Context

`src/composites/parallel.ts` is at 83% coverage with 19 existing tests. The gaps are in `serialize()`/`restore()` for the completedMap, parent signal handling when already aborted, and abort propagation.

### Files

- Modify: `src/composites/parallel.test.ts`
- Reference: `src/composites/parallel.ts` (source under test)
- Reference: `src/core/content-hash.ts` (content hashing used in serialize)

### Approach

Use real `ParallelNode` with mock `BTreeNode` children following existing test patterns.

---

- [ ] **Step 1: Add serialize/restore tests**

- `serialize()` returns `completedMap` as hash-to-status mapping after partial tick (mix of completed and RUNNING children)
- `restore()` rebuilds `completedMap`, subsequent tick skips already-completed non-reactive children
- `restore()` skips unknown hashes gracefully

- [ ] **Step 2: Add signal edge case tests**

- Parent signal already aborted before tick — child controllers are aborted immediately
- `abort()` aborts all child AbortControllers and calls `child.abort()` on each

- [ ] **Step 3: Run tests and verify coverage**

```bash
npx vitest run src/composites/parallel.test.ts
npx vitest run --config vitest.coverage.ts 2>&1 | grep "parallel"
```

Expected: `src/composites/parallel.ts` coverage rises to ~93%.
