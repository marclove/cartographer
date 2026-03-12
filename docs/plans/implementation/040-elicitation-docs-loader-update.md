# Task 40: Documentation and TreeLoader Update

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update TreeLoader's non-serializable options table, update JSDoc on TreeContext and BehaviorTreeConfig, and update BaseNode's class doc to describe context layering.

**Depends on:** Tasks 35, 36, 37, 38

---

### Step 1: Update TreeLoader docs

Edit `src/config/loader.ts` — the non-serializable options table in the class JSDoc. `onElicitation` is already listed. Verify it's accurate and add a note that it can be set at the tree level via `BehaviorTreeConfig.onElicitation` as an alternative to per-node configuration.

### Step 2: Update BaseNode JSDoc

Edit `src/nodes/base.ts` — update the class-level JSDoc to describe the context layering mechanism:

- Document `contextOverrides` and `setContextOverrides()`/`mergeContextOverrides()`
- Explain the merge semantics: shallow spread, closest override wins
- Note that this is how `onElicitation` propagates through the tree

### Step 3: Update TreeContext JSDoc

Edit `src/types.ts` — update the `TreeContext` interface JSDoc to mention that context fields can be overridden per-subtree via `BaseNode.setContextOverrides()`, and that `onElicitation` is the first field to use this mechanism.

### Step 4: Update ROADMAP.md

Edit `ROADMAP.md` — mark Phase 1 as implemented and add notes about the context layering infrastructure that was built, since it will be leveraged by Phases 2 and 3.

### Step 5: Typecheck and test

Run: `npm run typecheck && npm run test`
Expected: All pass (documentation-only changes should not affect behavior).

### Step 6: Commit

```bash
git add src/config/loader.ts src/nodes/base.ts src/types.ts ROADMAP.md
git commit -m "docs: document context layering, elicitation support, and update roadmap"
```
