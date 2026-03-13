# Task 64: isReactiveNode Helper

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the `isReactiveNode()` helper function that composites use to determine whether a child should be re-evaluated every tick (reactive) or cached within a cycle (non-reactive).

**Architecture:** Uses `instanceof` checks, recursing through single-child decorators to find the leaf. `ConditionNode` → reactive. Everything else → non-reactive. Decorators inherit from their child.

**Tech Stack:** TypeScript, vitest

**Spec Reference:** `docs/superpowers/specs/2026-03-13-reactive-tick-model-design.md` — Section 3

---

### Step 1: Write failing tests

Create `src/composites/is-reactive-node.test.ts`:

- `ConditionNode` returns `true`
- `ActionNode` returns `false`
- `AgentNode` returns `false`
- `SequenceNode` returns `false`
- `SelectorNode` returns `false`
- `Inverter(ConditionNode)` returns `true` (decorator wrapping condition)
- `Inverter(ActionNode)` returns `false` (decorator wrapping action)
- `AlwaysSucceed(Guard(ConditionNode))` returns `true` (nested decorators)
- `AlwaysSucceed(Inverter(ActionNode))` returns `false`

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/composites/is-reactive-node.test.ts`
Expected: FAIL — function doesn't exist

### Step 3: Implement isReactiveNode

Create `src/composites/is-reactive-node.ts`:

```typescript
import type { BTreeNode } from '../types.js';
import { ConditionNode } from '../nodes/condition.js';
import { DecoratorNode } from '../decorators/decorator-node.js';

export function isReactiveNode(node: BTreeNode): boolean {
  if (node instanceof ConditionNode) return true;
  if (node instanceof DecoratorNode) return isReactiveNode(node.child);
  return false;
}
```

Note: Verify the actual base class name for decorators in the codebase — it may be `BaseDecorator` or similar. The decorator must expose a `child` property.

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/composites/is-reactive-node.test.ts`
Expected: PASS

### Step 5: Commit

```bash
git add src/composites/is-reactive-node.ts src/composites/is-reactive-node.test.ts
git commit -m "feat: add isReactiveNode helper for cycle-based completion tracking"
```
