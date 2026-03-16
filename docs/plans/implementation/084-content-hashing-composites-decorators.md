# Task 84: Content Hashing — Composites, Decorators, rootHash

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `contentHash()` on composites and decorators (Merkle propagation), and add `rootHash` to BehaviorTree.

**Depends on:** Task 83

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 2 (Content Hashing)

---

### Context

Composites hash from: `hash(type, [child_0_hash, child_1_hash, ...])`. Decorators hash from: `hash(type, config, child_hash)`. The root hash is a fingerprint of the entire tree — any change anywhere propagates up.

### Step 1: Override computeHash on composites

For SequenceNode, SelectorNode, ParallelNode — each includes its type name and the ordered list of children's hashes:

```ts
protected override computeHash(): string {
  const childHashes = this._children.map(c => c.contentHash());
  return computeContentHash('SequenceNode', childHashes);
}
```

Same pattern for SelectorNode (use `'SelectorNode'`) and ParallelNode (use `'ParallelNode'`, and include the policy config if it affects behavior).

### Step 2: Override computeHash on decorators

Each decorator includes its type, relevant config, and child hash. Examples:

**RetryNode:**
```ts
protected override computeHash(): string {
  return computeContentHash('RetryNode', String(this.maxRetries), this.child.contentHash());
}
```

**RepeatNode:**
```ts
protected override computeHash(): string {
  return computeContentHash('RepeatNode', String(this.count), this.child.contentHash());
}
```

**TimeoutNode:**
```ts
protected override computeHash(): string {
  return computeContentHash('TimeoutNode', String(this.timeoutMs), this.child.contentHash());
}
```

**InverterNode, AlwaysSucceedNode, AlwaysFail:**
```ts
protected override computeHash(): string {
  return computeContentHash('InverterNode', this.child.contentHash());
}
```

**GuardNode:**
```ts
protected override computeHash(): string {
  return computeContentHash('GuardNode', this.child.contentHash());
}
```

Check each decorator's constructor for config fields to include. The pattern: type name + any numeric/string config + child hash.

### Step 3: Add rootHash to BehaviorTree

Edit `src/core/behavior-tree.ts`:

```ts
/** Content hash of the root node — fingerprint of the entire tree topology. */
get rootHash(): string {
  return this.root.contentHash();
}
```

### Step 4: Write tests

Add to `src/core/content-hash.test.ts` or a new file:

```ts
describe('composite contentHash', () => {
  it('sequence hash includes children order', () => {
    const a = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ name: 'b', action: async () => NodeStatus.SUCCESS });
    const seq1 = new SequenceNode({ name: 'seq', children: [a, b] });
    const seq2 = new SequenceNode({ name: 'seq', children: [b, a] });
    expect(seq1.contentHash()).not.toBe(seq2.contentHash()); // order matters
  });

  it('same structure produces same hash', () => {
    const make = () => new SequenceNode({
      name: 'seq',
      children: [
        new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS }),
        new ActionNode({ name: 'b', action: async () => NodeStatus.SUCCESS }),
      ],
    });
    expect(make().contentHash()).toBe(make().contentHash());
  });

  it('changing a leaf changes the root hash', () => {
    const makeTree = (prompt: string) => new BehaviorTree({
      name: 'test',
      root: new SequenceNode({
        name: 'seq',
        children: [new AgentNode({ name: 'agent', prompt })],
      }),
    });
    expect(makeTree('Do X').rootHash).not.toBe(makeTree('Do Y').rootHash);
  });
});

describe('decorator contentHash', () => {
  it('includes config in hash', () => {
    const child = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const r3 = new RetryNode({ name: 'r3', child, maxRetries: 3 });
    const r5 = new RetryNode({ name: 'r5', child, maxRetries: 5 });
    expect(r3.contentHash()).not.toBe(r5.contentHash());
  });

  it('includes child in hash', () => {
    const a = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ name: 'b', action: async () => NodeStatus.SUCCESS });
    const inv1 = new InverterNode({ name: 'inv', child: a });
    const inv2 = new InverterNode({ name: 'inv', child: b });
    expect(inv1.contentHash()).not.toBe(inv2.contentHash());
  });
});
```

### Step 5: Run tests

Run: `npx vitest run src/core/ src/composites/ src/decorators/`
Expected: All pass.

### Step 6: Typecheck + full suite

Run: `npm run typecheck && npm run test`

### Step 7: Commit

```bash
git add src/composites/ src/decorators/ src/core/behavior-tree.ts src/core/content-hash.test.ts
git commit -m "feat(core): add content hashing to composites and decorators, add rootHash to BehaviorTree"
```
