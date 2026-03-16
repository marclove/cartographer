# Task 89: untilSuccess Decorator

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the `untilSuccess()` decorator factory that converts FAILURE to RUNNING, creating explicit suspension points for the tree actor.

**Depends on:** None

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 6 (untilSuccess)

---

### Context

`untilSuccess` is distinct from `RepeatNode` with `untilStatus: NodeStatus.SUCCESS`. `RepeatNode` re-ticks its child synchronously within a single `execute()` call and never returns RUNNING due to a child FAILURE — it loops internally. `untilSuccess` MUST return RUNNING to the caller on child FAILURE so that `runToCompletion()` can detect the suspension point via `hasInflightWork() === false`.

### Step 1: Write failing tests

Create `src/decorators/until-success.test.ts`:

```ts
describe('UntilSuccessNode', () => {
  it('returns SUCCESS when child succeeds', async () => {
    const child = new ActionNode({ name: 'ok', action: async () => NodeStatus.SUCCESS });
    const node = untilSuccess(child);
    const ctx = createTestContext();

    const status = await node.tick(ctx);
    // ActionNode returns RUNNING on first tick, so tick again
    await new Promise(r => setTimeout(r, 0));
    const status2 = await node.tick(ctx);
    expect(status2).toBe(NodeStatus.SUCCESS);
  });

  it('returns RUNNING when child fails (suspension point)', async () => {
    const child = new ActionNode({
      name: 'fail',
      action: async () => NodeStatus.FAILURE,
    });
    const node = untilSuccess(child);
    const ctx = createTestContext();

    await node.tick(ctx); // child starts → RUNNING
    await new Promise(r => setTimeout(r, 0));
    const status = await node.tick(ctx); // child returns FAILURE → untilSuccess returns RUNNING
    expect(status).toBe(NodeStatus.RUNNING);
  });

  it('passes through RUNNING from child (in-flight work)', async () => {
    let resolve: (s: NodeStatus) => void;
    const child = new ActionNode({
      name: 'slow',
      action: () => new Promise<NodeStatus>(r => { resolve = r; }),
    });
    const node = untilSuccess(child);
    const ctx = createTestContext();

    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING); // child still working
  });

  it('has no in-flight work when suspended (child failed)', async () => {
    const child = new ActionNode({
      name: 'fail',
      action: async () => NodeStatus.FAILURE,
    });
    const node = untilSuccess(child);
    const ctx = createTestContext();

    await node.tick(ctx);
    await new Promise(r => setTimeout(r, 0));
    await node.tick(ctx); // RUNNING (suspension)

    expect(node.hasInflightWork()).toBe(false);
  });

  it('resets child on each re-evaluation after suspension', async () => {
    let callCount = 0;
    const child = new ActionNode({
      name: 'counting',
      action: async () => { callCount++; return NodeStatus.FAILURE; },
    });
    const node = untilSuccess(child);
    const ctx = createTestContext();

    // First evaluation: child fails → RUNNING
    await node.tick(ctx);
    await new Promise(r => setTimeout(r, 0));
    await node.tick(ctx);
    expect(callCount).toBe(1);

    // Reset child so next tick starts fresh (simulating what TreeActor does between messages)
    child.reset();

    // Second evaluation: child fails again → RUNNING
    await node.tick(ctx);
    await new Promise(r => setTimeout(r, 0));
    await node.tick(ctx);
    expect(callCount).toBe(2);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/decorators/until-success.test.ts`
Expected: FAIL — module not found.

### Step 3: Implement UntilSuccessNode

Create `src/decorators/until-success.ts`:

```ts
import { BaseDecorator } from './base-decorator.js'; // or whatever the decorator base is
import { NodeStatus } from '../types.js';
import type { TreeContext, BTreeNode } from '../types.js';
import { computeContentHash } from '../core/content-hash.js';

export class UntilSuccessNode extends BaseDecorator {
  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const status = await this.child.tick(context);
    if (status === NodeStatus.FAILURE) {
      return NodeStatus.RUNNING; // suspension point
    }
    return status; // SUCCESS passes through, RUNNING passes through
  }

  protected override computeHash(): string {
    return computeContentHash('UntilSuccessNode', this.child.contentHash());
  }
}

/** Factory function for creating an UntilSuccessNode. */
export function untilSuccess(child: BTreeNode): UntilSuccessNode {
  return new UntilSuccessNode({ name: 'untilSuccess', child });
}
```

Check the existing decorator pattern (e.g., `src/decorators/inverter.ts`) for the correct base class name and constructor pattern.

### Step 4: Run tests

Run: `npx vitest run src/decorators/until-success.test.ts`
Expected: All pass.

### Step 5: Typecheck + full suite

Run: `npm run typecheck && npm run test`

### Step 6: Commit

```bash
git add src/decorators/until-success.ts src/decorators/until-success.test.ts
git commit -m "feat(decorators): add untilSuccess decorator for explicit suspension points"
```
