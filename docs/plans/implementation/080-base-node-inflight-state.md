# Task 80: BaseNode _inflightState + hasInflightWork / inflightPromise

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move `_inflightState` from private fields on ActionNode/AgentNode to a protected field on BaseNode, and add `hasInflightWork()` / `inflightPromise()` methods to the BTreeNode interface and BaseNode.

**Depends on:** None

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 1 (Processing Loop, Tick Loop)

---

### Context

`_inflightState` is currently `private` on both `ActionNode` (`src/nodes/action.ts`) and `AgentNode` (`src/nodes/agent.ts`). The spec requires tree-level in-flight detection via `hasInflightWork()` and `inflightPromise()`. These need to be on the BTreeNode interface so composites and the BehaviorTree can delegate recursively.

The `_inflightState` field has the shape: `{ promise: Promise<NodeStatus>; result?: NodeStatus; error?: Error } | null`. A node has *unsettled* in-flight work when `_inflightState` is non-null AND neither `result` nor `error` has been populated yet. A node whose promise has resolved but hasn't been collected by a subsequent tick is NOT considered in-flight.

### Step 1: Add methods to BTreeNode interface

Edit `src/types.ts` — add to the `BTreeNode` interface:

```ts
/** Returns true if this node has unsettled in-flight async work. */
hasInflightWork(): boolean;

/** Returns the in-flight promise if unsettled work exists, null otherwise. */
inflightPromise(): Promise<void> | null;
```

### Step 2: Add _inflightState field and default implementations to BaseNode

Edit `src/nodes/base.ts`:

Add a protected field:
```ts
protected _inflightState: {
  promise: Promise<NodeStatus>;
  result?: NodeStatus;
  error?: Error;
} | null = null;
```

Add default implementations:
```ts
hasInflightWork(): boolean {
  if (!this._inflightState) return false;
  return this._inflightState.result === undefined && this._inflightState.error === undefined;
}

inflightPromise(): Promise<void> | null {
  if (!this.hasInflightWork()) return null;
  return this._inflightState!.promise.then(() => {});
}
```

### Step 3: Update ActionNode to use inherited _inflightState

Edit `src/nodes/action.ts`:

- Remove the private `_inflightState` field declaration (it's now inherited from BaseNode).
- Verify that all references to `this._inflightState` still work (they should — `protected` is accessible from subclasses).
- No logic changes needed — the field shape is identical.

### Step 4: Update AgentNode to use inherited _inflightState

Edit `src/nodes/agent.ts`:

- Remove the private `_inflightState` field declaration.
- Same verification as ActionNode.

### Step 5: Write tests

Add to `src/nodes/base.test.ts` (or create if needed):

```ts
describe('hasInflightWork / inflightPromise', () => {
  it('returns false/null when no inflight state', async () => {
    const node = new ActionNode({ name: 'test', action: async () => NodeStatus.SUCCESS });
    expect(node.hasInflightWork()).toBe(false);
    expect(node.inflightPromise()).toBeNull();
  });

  it('returns true after first tick starts async work', async () => {
    let resolve: (status: NodeStatus) => void;
    const node = new ActionNode({
      name: 'test',
      action: () => new Promise<NodeStatus>(r => { resolve = r; }),
    });
    const ctx = createTestContext();
    await node.tick(ctx); // starts work, returns RUNNING
    expect(node.hasInflightWork()).toBe(true);
    expect(node.inflightPromise()).toBeInstanceOf(Promise);
    resolve!(NodeStatus.SUCCESS);
  });

  it('returns false after promise settles but before collection tick', async () => {
    let resolve: (status: NodeStatus) => void;
    const node = new ActionNode({
      name: 'test',
      action: () => new Promise<NodeStatus>(r => { resolve = r; }),
    });
    const ctx = createTestContext();
    await node.tick(ctx);
    resolve!(NodeStatus.SUCCESS);
    await new Promise(r => setTimeout(r, 0)); // let microtask settle
    expect(node.hasInflightWork()).toBe(false);
    expect(node.inflightPromise()).toBeNull();
  });

  it('returns false after collection tick returns result', async () => {
    let resolve: (status: NodeStatus) => void;
    const node = new ActionNode({
      name: 'test',
      action: () => new Promise<NodeStatus>(r => { resolve = r; }),
    });
    const ctx = createTestContext();
    await node.tick(ctx);
    resolve!(NodeStatus.SUCCESS);
    await new Promise(r => setTimeout(r, 0));
    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.SUCCESS);
    expect(node.hasInflightWork()).toBe(false);
  });
});
```

Use `createTestContext()` from existing test helpers (check `src/nodes/action.test.ts` for the pattern).

### Step 6: Run tests

Run: `npx vitest run src/nodes/`
Expected: All pass — existing ActionNode and AgentNode tests still pass, new tests pass.

### Step 7: Typecheck

Run: `npm run typecheck`
Expected: All pass.

### Step 8: Commit

```bash
git add src/types.ts src/nodes/base.ts src/nodes/action.ts src/nodes/agent.ts src/nodes/base.test.ts
git commit -m "feat(core): move _inflightState to BaseNode, add hasInflightWork/inflightPromise to BTreeNode"
```
