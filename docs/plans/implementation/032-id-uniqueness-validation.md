# Task 32: ID Uniqueness Validation in BehaviorTree

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enforce that every node in a tree has a unique `id` by validating at construction time. Throws a descriptive error listing the duplicate ID and the offending node name.

**Architecture:** `BehaviorTree.constructor` calls a private static `validateUniqueIds` method that walks the tree iteratively using the `children` accessor (from Task 30) and collects IDs into a `Set`. On the first duplicate, it throws an `Error`.

**Tech Stack:** TypeScript, vitest

**Depends on:** Task 30 (children accessor), Task 31 (custom IDs)

---

### Step 1: Write failing tests

Add to `src/core/behavior-tree.test.ts`. These tests need `ActionNode` and `SequenceNode` imports:

```typescript
  it('throws on duplicate node IDs', () => {
    const a = new ActionNode({ id: 'dupe', name: 'a', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ id: 'dupe', name: 'b', action: async () => NodeStatus.SUCCESS });
    const root = new SequenceNode({ name: 'root', children: [a, b] });

    expect(() => new BehaviorTree({ name: 'tree', root })).toThrow(/duplicate.*id/i);
  });

  it('allows unique custom IDs', () => {
    const a = new ActionNode({ id: 'node-a', name: 'a', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ id: 'node-b', name: 'b', action: async () => NodeStatus.SUCCESS });
    const root = new SequenceNode({ name: 'root', children: [a, b] });

    expect(() => new BehaviorTree({ name: 'tree', root })).not.toThrow();
  });

  it('detects duplicate IDs in nested trees', () => {
    const leaf = new ActionNode({ id: 'leaf', name: 'leaf', action: async () => NodeStatus.SUCCESS });
    const inner = new SequenceNode({ name: 'inner', children: [leaf] });
    const outerLeaf = new ActionNode({ id: 'leaf', name: 'leaf2', action: async () => NodeStatus.SUCCESS });
    const root = new SequenceNode({ name: 'root', children: [inner, outerLeaf] });

    expect(() => new BehaviorTree({ name: 'tree', root })).toThrow(/duplicate.*id.*leaf/i);
  });

  it('allows trees with auto-generated IDs', () => {
    const a = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ name: 'b', action: async () => NodeStatus.SUCCESS });
    const root = new SequenceNode({ name: 'root', children: [a, b] });

    expect(() => new BehaviorTree({ name: 'tree', root })).not.toThrow();
  });
```

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/core/behavior-tree.test.ts`
Expected: FAIL — the duplicate ID test does not throw.

### Step 3: Implement ID validation

Modify `src/core/behavior-tree.ts`. Add a call in the constructor and the validation method:

In the constructor, after the existing assignments:
```typescript
    BehaviorTree.validateUniqueIds(this.root);
```

Add the static method to the class:
```typescript
  /**
   * Walk the tree and verify that every node has a unique ID.
   *
   * Uses the `children` accessor on `BTreeNode` to traverse the tree
   * iteratively. Throws on the first duplicate ID found.
   */
  private static validateUniqueIds(root: BTreeNode): void {
    const seen = new Set<string>();
    const stack: BTreeNode[] = [root];

    while (stack.length > 0) {
      const node = stack.pop()!;
      if (seen.has(node.id)) {
        throw new Error(
          `Duplicate node ID "${node.id}" found in tree. ` +
          `Node IDs must be unique. The duplicate was found on node "${node.name}".`
        );
      }
      seen.add(node.id);
      for (const child of node.children) {
        stack.push(child);
      }
    }
  }
```

### Step 4: Run tests

Run: `npm run typecheck && npm run test`
Expected: All pass, including the four new duplicate-ID tests.

### Step 5: Commit

```bash
git add src/core/behavior-tree.ts src/core/behavior-tree.test.ts
git commit -m "feat: validate node ID uniqueness in BehaviorTree constructor"
```
