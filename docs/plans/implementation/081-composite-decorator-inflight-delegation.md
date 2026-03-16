# Task 81: Composite/Decorator Recursive Inflight Delegation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Override `hasInflightWork()` and `inflightPromise()` on composites and decorators to recursively delegate to their children.

**Depends on:** Task 80

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 1 (Processing Loop)

---

### Context

BaseNode's default `hasInflightWork()` only checks the node's own `_inflightState`. Composites and decorators need to also check their children. A tree's `hasInflightWork()` must return true if *any* node in the subtree has unsettled work.

### Step 1: Override on BaseComposite (or each composite individually)

Check whether composites share a base class. If there's a `BaseComposite` in `src/composites/`, add the override there. Otherwise, add to `SequenceNode`, `SelectorNode`, and `ParallelNode` individually.

```ts
hasInflightWork(): boolean {
  if (super.hasInflightWork()) return true;
  return this._children.some(child => child.hasInflightWork());
}

inflightPromise(): Promise<void> | null {
  const promises: Promise<void>[] = [];
  const own = super.inflightPromise();
  if (own) promises.push(own);
  for (const child of this._children) {
    const p = child.inflightPromise();
    if (p) promises.push(p);
  }
  return promises.length > 0 ? Promise.all(promises).then(() => {}) : null;
}
```

### Step 2: Override on BaseDecorator (or each decorator individually)

Same pattern — check for a shared decorator base class. Each decorator has a single child (`this.child` or `this._child`):

```ts
hasInflightWork(): boolean {
  if (super.hasInflightWork()) return true;
  return this.child.hasInflightWork();
}

inflightPromise(): Promise<void> | null {
  const promises: Promise<void>[] = [];
  const own = super.inflightPromise();
  if (own) promises.push(own);
  const childPromise = this.child.inflightPromise();
  if (childPromise) promises.push(childPromise);
  return promises.length > 0 ? Promise.all(promises).then(() => {}) : null;
}
```

### Step 3: Write tests

Test with a sequence containing an ActionNode with deferred work:

```ts
describe('composite inflight delegation', () => {
  it('sequence reports inflight work from a child', async () => {
    let resolve: (s: NodeStatus) => void;
    const slow = new ActionNode({
      name: 'slow',
      action: () => new Promise<NodeStatus>(r => { resolve = r; }),
    });
    const seq = new SequenceNode({ name: 'seq', children: [slow] });
    const ctx = createTestContext();

    await seq.tick(ctx); // slow starts, returns RUNNING
    expect(seq.hasInflightWork()).toBe(true);
    expect(seq.inflightPromise()).toBeInstanceOf(Promise);

    resolve!(NodeStatus.SUCCESS);
    await new Promise(r => setTimeout(r, 0));
    expect(seq.hasInflightWork()).toBe(false);
  });
});

describe('decorator inflight delegation', () => {
  it('decorator reports inflight work from its child', async () => {
    let resolve: (s: NodeStatus) => void;
    const slow = new ActionNode({
      name: 'slow',
      action: () => new Promise<NodeStatus>(r => { resolve = r; }),
    });
    const decorated = new AlwaysSucceedNode({ name: 'wrap', child: slow });
    const ctx = createTestContext();

    await decorated.tick(ctx);
    expect(decorated.hasInflightWork()).toBe(true);

    resolve!(NodeStatus.SUCCESS);
    await new Promise(r => setTimeout(r, 0));
    expect(decorated.hasInflightWork()).toBe(false);
  });
});
```

### Step 4: Run tests

Run: `npx vitest run src/composites/ src/decorators/`
Expected: All pass.

### Step 5: Typecheck

Run: `npm run typecheck`

### Step 6: Commit

```bash
git add src/composites/ src/decorators/
git commit -m "feat(core): add recursive hasInflightWork/inflightPromise to composites and decorators"
```
