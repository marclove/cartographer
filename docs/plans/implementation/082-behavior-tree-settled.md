# Task 82: BehaviorTree hasInflightWork + settled

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add tree-level `hasInflightWork()` and `settled()` methods to BehaviorTree.

**Depends on:** Task 81

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 1 (Processing Loop)

---

### Step 1: Implement on BehaviorTree

Edit `src/core/behavior-tree.ts`:

```ts
/** Returns true if any node in the tree has unsettled in-flight work. */
hasInflightWork(): boolean {
  return this.root.hasInflightWork();
}

/**
 * Returns a promise that resolves when all in-flight work across the tree has settled.
 * Uses Promise.all (not allSettled) — nodes handle their own errors internally.
 * An unhandled rejection here indicates a bug that should surface.
 */
async settled(): Promise<void> {
  const promise = this.root.inflightPromise();
  if (promise) await promise;
}
```

### Step 2: Write tests

Add to `src/core/behavior-tree.test.ts`:

```ts
describe('hasInflightWork / settled', () => {
  it('returns false when tree has no inflight work', async () => {
    const tree = new BehaviorTree({
      name: 'test',
      root: new ActionNode({ name: 'fast', action: async () => NodeStatus.SUCCESS }),
    });
    expect(tree.hasInflightWork()).toBe(false);
  });

  it('returns true when a node has inflight work', async () => {
    let resolve: (s: NodeStatus) => void;
    const tree = new BehaviorTree({
      name: 'test',
      root: new ActionNode({
        name: 'slow',
        action: () => new Promise<NodeStatus>(r => { resolve = r; }),
      }),
    });

    await tree.tick(); // starts work
    expect(tree.hasInflightWork()).toBe(true);

    resolve!(NodeStatus.SUCCESS);
    await tree.settled();
    expect(tree.hasInflightWork()).toBe(false);
  });

  it('settled() resolves immediately when no inflight work', async () => {
    const tree = new BehaviorTree({
      name: 'test',
      root: new ActionNode({ name: 'fast', action: async () => NodeStatus.SUCCESS }),
    });
    await tree.settled(); // should not hang
  });

  it('settled() waits for deeply nested inflight work', async () => {
    let resolve: (s: NodeStatus) => void;
    const tree = new BehaviorTree({
      name: 'test',
      root: new SequenceNode({
        name: 'seq',
        children: [
          new ActionNode({
            name: 'slow',
            action: () => new Promise<NodeStatus>(r => { resolve = r; }),
          }),
        ],
      }),
    });

    await tree.tick();
    expect(tree.hasInflightWork()).toBe(true);

    const settledPromise = tree.settled();
    resolve!(NodeStatus.SUCCESS);
    await settledPromise;
    expect(tree.hasInflightWork()).toBe(false);
  });
});
```

### Step 3: Run tests

Run: `npx vitest run src/core/behavior-tree.test.ts`
Expected: All pass.

### Step 4: Typecheck + full test suite

Run: `npm run typecheck && npm run test`
Expected: All pass.

### Step 5: Commit

```bash
git add src/core/behavior-tree.ts src/core/behavior-tree.test.ts
git commit -m "feat(core): add hasInflightWork/settled to BehaviorTree for tree-level in-flight detection"
```
