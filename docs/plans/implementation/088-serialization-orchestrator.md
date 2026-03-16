# Task 88: Serialization Orchestrator + Topology Versioning

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the tree-level orchestration that walks the tree to serialize/restore all nodes, builds the `hashToNode` index, handles duplicate hash disambiguation, and validates topology via rootHash.

**Depends on:** Tasks 84, 85, 86, 87

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 2 (Restore Process, Topology Versioning, Duplicate Node Handling)

---

### Context

Individual nodes now have `contentHash()`, `serialize()`, and `restore()`. This task wires them together at the tree level: walking the tree to collect/restore state, building the hash→node index, handling hash collisions, and validating rootHash on restore.

### Step 1: Add serializeTree and restoreTree to serialization.ts

Edit `src/core/serialization.ts`:

```ts
import type { BTreeNode } from '../types.js';

/**
 * Walk the tree depth-first, compute content hashes, and build a hash→node index.
 * Handles duplicate hashes by appending occurrence index (e.g., 'abc123:0', 'abc123:1').
 */
export function buildHashIndex(root: BTreeNode): Map<string, BTreeNode> {
  const counts = new Map<string, number>();
  const index = new Map<string, BTreeNode>();

  function walk(node: BTreeNode): void {
    const rawHash = node.contentHash();
    const count = counts.get(rawHash) ?? 0;
    counts.set(rawHash, count + 1);

    const key = count > 0 ? `${rawHash}:${count}` : rawHash;
    // Retroactively disambiguate the first occurrence if we just found a duplicate
    if (count === 1) {
      const firstNode = index.get(rawHash)!;
      index.delete(rawHash);
      index.set(`${rawHash}:0`, firstNode);
    }
    index.set(key, node);

    // Recurse into children
    if ('children' in node && Array.isArray((node as any).children)) {
      for (const child of (node as any).children) {
        walk(child);
      }
    }
    // Decorators have a single child
    if ('child' in node && (node as any).child) {
      walk((node as any).child);
    }
  }

  walk(root);
  return index;
}

/**
 * Serialize the entire tree's execution state.
 */
export function serializeTree(root: BTreeNode, rootHash: string): SerializedTreeState {
  const index = buildHashIndex(root);
  const nodes: Record<string, NodeState> = {};

  for (const [hash, node] of index) {
    const state = node.serialize();
    if (Object.keys(state).length > 0) {
      nodes[hash] = state;
    }
  }

  return { rootHash, nodes };
}

/**
 * Restore tree execution state. Throws if rootHash doesn't match.
 */
export function restoreTree(
  root: BTreeNode,
  currentRootHash: string,
  stored: SerializedTreeState,
  policy: 'fail' | 'reset' = 'fail',
): void {
  if (stored.rootHash !== currentRootHash) {
    if (policy === 'fail') {
      throw new Error(
        `Tree topology changed: stored rootHash ${stored.rootHash} does not match factory rootHash ${currentRootHash}`
      );
    }
    // Reset policy: skip restoration, tree starts fresh
    return;
  }

  const index = buildHashIndex(root);

  for (const [hash, state] of Object.entries(stored.nodes)) {
    const node = index.get(hash);
    if (!node) {
      throw new Error(`Stored state references unknown node hash: ${hash}`);
    }
    node.restore(state, index);
  }
}
```

Note: The `walk` function needs access to a node's children. Check how the existing codebase exposes children — there may be a `children` accessor (Task 30 added one). Use whatever pattern exists. If composites expose `children` as a getter and decorators expose `child`, use those.

### Step 2: Write tests

Add to `src/core/serialization.test.ts`:

```ts
describe('buildHashIndex', () => {
  it('builds flat index from tree', () => {
    const a = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ name: 'b', action: async () => NodeStatus.SUCCESS });
    const seq = new SequenceNode({ name: 'seq', children: [a, b] });

    const index = buildHashIndex(seq);
    expect(index.size).toBe(3); // seq + a + b
    expect(index.get(a.contentHash())).toBe(a);
    expect(index.get(b.contentHash())).toBe(b);
    expect(index.get(seq.contentHash())).toBe(seq);
  });

  it('disambiguates duplicate hashes', () => {
    const a1 = new ActionNode({ name: 'dup', action: async () => NodeStatus.SUCCESS });
    const a2 = new ActionNode({ name: 'dup', action: async () => NodeStatus.SUCCESS });
    const seq = new SequenceNode({ name: 'seq', children: [a1, a2] });

    const index = buildHashIndex(seq);
    const rawHash = a1.contentHash();
    expect(index.has(`${rawHash}:0`)).toBe(true);
    expect(index.has(`${rawHash}:1`)).toBe(true);
    expect(index.get(`${rawHash}:0`)).toBe(a1);
    expect(index.get(`${rawHash}:1`)).toBe(a2);
  });
});

describe('serializeTree / restoreTree', () => {
  it('round-trips tree state', async () => {
    const makeTree = () => {
      const a = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
      const b = new ActionNode({ name: 'b', action: async () => NodeStatus.SUCCESS });
      return new SequenceNode({ name: 'seq', children: [a, b] });
    };

    const tree1 = makeTree();
    // Tick to create some state...
    const ctx = createTestContext();
    await tree1.tick(ctx);
    await new Promise(r => setTimeout(r, 0));
    await tree1.tick(ctx);

    const rootHash = tree1.contentHash();
    const serialized = serializeTree(tree1, rootHash);

    const tree2 = makeTree();
    restoreTree(tree2, tree2.contentHash(), serialized);
    // tree2 should now have the same state as tree1
    expect(serializeTree(tree2, tree2.contentHash())).toEqual(serialized);
  });

  it('throws on rootHash mismatch with fail policy', () => {
    const tree = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const stored: SerializedTreeState = { rootHash: 'wrong', nodes: {} };
    expect(() => restoreTree(tree, tree.contentHash(), stored, 'fail')).toThrow(/topology changed/);
  });

  it('silently skips restore on rootHash mismatch with reset policy', () => {
    const tree = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const stored: SerializedTreeState = { rootHash: 'wrong', nodes: {} };
    expect(() => restoreTree(tree, tree.contentHash(), stored, 'reset')).not.toThrow();
  });
});
```

### Step 3: Run tests

Run: `npx vitest run src/core/serialization.test.ts`
Expected: All pass.

### Step 4: Typecheck + full suite

Run: `npm run typecheck && npm run test`

### Step 5: Commit

```bash
git add src/core/serialization.ts src/core/serialization.test.ts
git commit -m "feat(core): add tree-level serialization orchestrator with hash index and topology versioning"
```
