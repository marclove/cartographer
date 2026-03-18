# Task 115: Selector Serialize/Restore Tests — `src/composites/selector.ts` (77% -> ~90%)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add tests for serialization, restore, and edge cases in SelectorNode.

**Depends on:** None

---

### Context

`src/composites/selector.ts` is at 77% coverage with 22 existing tests. The main gaps are in `serialize()`/`restore()` paths, empty children edge case, and abort propagation.

### Files

- Modify: `src/composites/selector.test.ts`
- Reference: `src/composites/selector.ts` (source under test)
- Reference: `src/core/content-hash.ts` (content hashing used in serialize)

### Approach

Use real `SelectorNode` with mock `BTreeNode` children following existing test patterns in the file.

---

- [ ] **Step 1: Add serialize/restore tests**

- `serialize()` returns `committedOrder` as content hash array and `completedMap` as hash-to-status mapping after a partial tick (some children completed, some still RUNNING)
- `restore()` rebuilds `committedOrder` and `completedMap` from serialized state, subsequent tick resumes correctly
- `restore()` silently skips unknown hashes (partial restore when tree structure changed)

- [ ] **Step 2: Add edge case tests**

- Empty children array returns FAILURE immediately without consulting strategy
- `abort()` propagates to all children and clears internal state

- [ ] **Step 3: Run tests and verify coverage**

```bash
npx vitest run src/composites/selector.test.ts
npx vitest run --config vitest.coverage.ts 2>&1 | grep "selector"
```

Expected: `src/composites/selector.ts` coverage rises to ~90%.
