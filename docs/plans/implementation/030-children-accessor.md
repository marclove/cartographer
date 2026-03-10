# Task 30: Children Accessor on BTreeNode

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `readonly children` accessor to `BTreeNode` so the tree can be walked generically. Leaf nodes return `[]`, composites return their children array, decorators return `[child]`.

**Architecture:** Add `children` to the `BTreeNode` interface. `BaseNode` provides a default getter returning `[]`. Composites change their private `children` field to `override readonly children`. Decorators add an `override get children()` returning `[this.child]`.

**Tech Stack:** TypeScript, vitest

---

### Step 1: Add `children` to the `BTreeNode` interface

Modify `src/types.ts`. Add to the `BTreeNode` interface, after the `name` field:

```typescript
  /**
   * The direct child nodes of this node.
   *
   * Leaf nodes return an empty array. Composites return their child list.
   * Decorators return a single-element array containing their wrapped child.
   * Used by `BehaviorTree` to walk the tree for validation (e.g. ID
   * uniqueness checks).
   */
  readonly children: readonly BTreeNode[];
```

### Step 2: Add default `children` getter to `BaseNode`

Modify `src/nodes/base.ts`. Add a getter to the class body (after `name`):

```typescript
  get children(): readonly BTreeNode[] {
    return [];
  }
```

### Step 3: Fix composites — expose `children` as a readonly field

The three composite classes (`SelectorNode`, `SequenceNode`, `ParallelNode`) each have `private children: ...Config['children']`. Override the base getter with a readonly field.

In `src/composites/selector.ts`, replace:
```typescript
  private children: SelectorConfig['children'];
```
with:
```typescript
  override readonly children: readonly BTreeNode[];
```
And in the constructor, change the assignment to copy the array:
```typescript
    this.children = [...config.children];
```

Apply the identical pattern to `src/composites/sequence.ts` and `src/composites/parallel.ts`.

### Step 4: Fix decorators — add `children` getter

Each decorator has a `private child` field. Add a getter that returns `[child]`.

In each of the seven decorator files (`src/decorators/inverter.ts`, `src/decorators/always-succeed.ts`, `src/decorators/always-fail.ts`, `src/decorators/retry.ts`, `src/decorators/repeat.ts`, `src/decorators/timeout.ts`, `src/decorators/guard.ts`), add after the `child` field declaration:

```typescript
  override get children(): readonly BTreeNode[] {
    return [this.child];
  }
```

Each decorator file will also need to import the `BTreeNode` type if it isn't already imported.

### Step 5: Update mock nodes in test files

Any test file that creates mock `BTreeNode` objects needs `children: []`. Add it to mock node factories in:

- `src/strategies/agent-strategies.test.ts` — `mockNode()` function
- `src/composites/selector.test.ts` — inline mock objects
- `src/composites/sequence.test.ts` — inline mock objects
- `src/composites/parallel.test.ts` — inline mock objects
- `src/decorators/*.test.ts` — `mockChild()` functions
- `src/core/behavior-tree.test.ts` — mock nodes
- `src/tree-logger.test.ts` — mock nodes

### Step 6: Run tests

Run: `npm run typecheck && npm run test`
Expected: All pass. The `children` accessor is now available on every node.

### Step 7: Commit

```bash
git add src/types.ts src/nodes/base.ts src/composites/ src/decorators/ src/**/*.test.ts
git commit -m "feat: add children accessor to BTreeNode for generic tree walking"
```
