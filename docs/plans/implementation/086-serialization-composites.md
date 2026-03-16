# Task 86: Serialization — Composites

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `serialize()` and `restore()` on SequenceNode, SelectorNode, and ParallelNode. This is the hardest serialization task — `completedMap` is keyed by live node references and must be re-keyed by content hash.

**Depends on:** Tasks 83, 84, 85

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 2 (Serializable Execution State, Restore Process)

---

### Context

The existing composites have:
- `completedMap: Map<BTreeNode, NodeStatus>` — keyed by live node reference
- `committedOrder: BTreeNode[] | null` — resolved child evaluation order

Serialization must convert these to content-hash-keyed structures. Restoration must resolve hashes back to live node references using the `hashToNode` index.

**Critical invariant:** `completedMap` serialization fidelity is a correctness requirement for `actionReceived` consume-on-read safety. If a cached SUCCESS is lost during round-trip, the sequence re-ticks `actionReceived`, the blackboard key is gone, and the user's action is silently dropped.

### Step 1: Implement serialize on SequenceNode

Edit `src/composites/sequence.ts`:

```ts
serialize(): NodeState {
  const state: NodeState = {};

  if (this.committedOrder) {
    state.committedOrder = this.committedOrder.map(child => child.contentHash());
  }

  if (this.completedMap.size > 0) {
    state.completedMap = {};
    for (const [node, status] of this.completedMap) {
      state.completedMap[node.contentHash()] = status;
    }
  }

  return state;
}
```

### Step 2: Implement restore on SequenceNode

```ts
restore(state: NodeState, hashToNode: Map<string, BTreeNode>): void {
  if (state.committedOrder) {
    this.committedOrder = state.committedOrder
      .map(hash => hashToNode.get(hash))
      .filter((n): n is BTreeNode => n !== undefined);
  }

  if (state.completedMap) {
    this.completedMap.clear();
    for (const [hash, status] of Object.entries(state.completedMap)) {
      const node = hashToNode.get(hash);
      if (node) {
        this.completedMap.set(node, status);
      }
    }
  }
}
```

### Step 3: Implement on SelectorNode

Same pattern as SequenceNode — check `src/composites/selector.ts` for field names (they should match: `committedOrder`, `completedMap`).

### Step 4: Implement on ParallelNode

ParallelNode has `completedMap` but may not have `committedOrder` (children run in parallel). Check the actual fields. Serialize `completedMap` the same way.

### Step 5: Write tests

Create or add to `src/core/serialization.test.ts`:

```ts
describe('composite serialization', () => {
  it('SequenceNode round-trips completedMap', async () => {
    const a = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ name: 'b', action: async () => NodeStatus.SUCCESS });
    const seq = new SequenceNode({ name: 'seq', children: [a, b] });
    const ctx = createTestContext();

    // Tick until 'a' completes and is in completedMap
    await seq.tick(ctx); // a starts → RUNNING
    await new Promise(r => setTimeout(r, 0));
    await seq.tick(ctx); // a completes → SUCCESS, b starts → RUNNING

    // Serialize
    const state = seq.serialize();
    expect(state.completedMap).toBeDefined();
    expect(state.completedMap![a.contentHash()]).toBe(NodeStatus.SUCCESS);

    // Create fresh tree and restore
    const a2 = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const b2 = new ActionNode({ name: 'b', action: async () => NodeStatus.SUCCESS });
    const seq2 = new SequenceNode({ name: 'seq', children: [a2, b2] });

    const hashToNode = new Map<string, BTreeNode>();
    hashToNode.set(a2.contentHash(), a2);
    hashToNode.set(b2.contentHash(), b2);

    seq2.restore(state, hashToNode);

    // Verify completedMap was restored with live references
    const restored = seq2.serialize();
    expect(restored.completedMap![a2.contentHash()]).toBe(NodeStatus.SUCCESS);
  });

  it('completedMap survives full serialize/restore cycle', async () => {
    // This test verifies the actionReceived consume-on-read invariant:
    // a non-reactive node's SUCCESS must survive serialization
    const checkNode = new ActionNode({ name: 'check', action: async () => NodeStatus.SUCCESS });
    const seq = new SequenceNode({ name: 'seq', children: [checkNode] });
    const ctx = createTestContext();

    // Complete the node
    await seq.tick(ctx);
    await new Promise(r => setTimeout(r, 0));
    await seq.tick(ctx);

    // Round-trip
    const state = seq.serialize();
    const checkNode2 = new ActionNode({ name: 'check', action: async () => NodeStatus.SUCCESS });
    const seq2 = new SequenceNode({ name: 'seq', children: [checkNode2] });
    const index = new Map([[checkNode2.contentHash(), checkNode2 as BTreeNode]]);
    seq2.restore(state, index);

    // The restored sequence should have checkNode2 in its completedMap
    const restoredState = seq2.serialize();
    expect(restoredState.completedMap?.[checkNode2.contentHash()]).toBe(NodeStatus.SUCCESS);
  });
});
```

### Step 6: Run tests

Run: `npx vitest run src/core/serialization.test.ts src/composites/`
Expected: All pass.

### Step 7: Typecheck + full suite

Run: `npm run typecheck && npm run test`

### Step 8: Commit

```bash
git add src/composites/sequence.ts src/composites/selector.ts src/composites/parallel.ts src/core/serialization.test.ts
git commit -m "feat(core): add serialize/restore to composite nodes with completedMap re-keying"
```
