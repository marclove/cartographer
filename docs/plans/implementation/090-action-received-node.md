# Task 90: actionReceived Node

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the `actionReceived()` node factory — a lightweight, non-reactive, synchronous node that checks and consumes action keys from the blackboard.

**Depends on:** None

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 6 (actionReceived)

---

### Context

`actionReceived` is its own node type extending BaseNode directly — NOT an ActionNode or ConditionNode. This matters for:
- **Non-reactive** — sequences cache its SUCCESS in `completedMap`. A reactive node would be re-ticked, find the consumed key gone, and return FAILURE.
- **Synchronous** — no `_inflightState` polling. Returns SUCCESS or FAILURE on the first tick. This means `hasInflightWork()` correctly reports false when the tree is suspended.

**Critical invariant:** consume-on-read safety depends on faithful `completedMap` serialization (see Task 86).

### Step 1: Write failing tests

Create `src/nodes/action-received.test.ts`:

```ts
describe('ActionReceivedNode', () => {
  it('returns SUCCESS and consumes key when action is present', async () => {
    const node = actionReceived('approve');
    const ctx = createTestContext();
    ctx.blackboard.set('actions:approve', { docId: '123' });

    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.SUCCESS);
    expect(ctx.blackboard.get('actions:approve')).toBeUndefined();
  });

  it('returns FAILURE when action is not present', async () => {
    const node = actionReceived('approve');
    const ctx = createTestContext();

    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.FAILURE);
  });

  it('is not reactive (isReactiveNode returns false)', () => {
    const node = actionReceived('approve');
    expect(isReactiveNode(node)).toBe(false);
  });

  it('has no inflight work after tick', async () => {
    const node = actionReceived('approve');
    const ctx = createTestContext();
    await node.tick(ctx);
    expect(node.hasInflightWork()).toBe(false);
  });

  it('calls mapPayload when action is present', async () => {
    const node = actionReceived('approve', {
      mapPayload: (payload, blackboard) => {
        blackboard.set('review:decision', payload.decision);
      },
    });
    const ctx = createTestContext();
    ctx.blackboard.set('actions:approve', { decision: 'accepted' });

    await node.tick(ctx);
    expect(ctx.blackboard.get('review:decision')).toBe('accepted');
  });

  it('does not call mapPayload when action is absent', async () => {
    let called = false;
    const node = actionReceived('approve', {
      mapPayload: () => { called = true; },
    });
    const ctx = createTestContext();
    await node.tick(ctx);
    expect(called).toBe(false);
  });

  it('produces stable content hash', () => {
    const a = actionReceived('approve');
    const b = actionReceived('approve');
    expect(a.contentHash()).toBe(b.contentHash());
  });

  it('produces different hash for different action names', () => {
    const a = actionReceived('approve');
    const b = actionReceived('reject');
    expect(a.contentHash()).not.toBe(b.contentHash());
  });
});
```

### Step 2: Implement ActionReceivedNode

Create `src/nodes/action-received.ts`:

```ts
import { BaseNode } from './base.js';
import { NodeStatus } from '../types.js';
import type { TreeContext, Blackboard } from '../types.js';
import { computeContentHash } from '../core/content-hash.js';

export interface ActionReceivedOptions {
  mapPayload?: (payload: unknown, blackboard: Blackboard) => void;
}

export class ActionReceivedNode extends BaseNode {
  private readonly actionName: string;
  private readonly mapPayload?: (payload: unknown, blackboard: Blackboard) => void;

  constructor(actionName: string, options?: ActionReceivedOptions) {
    super({ name: `actionReceived:${actionName}` });
    this.actionName = actionName;
    this.mapPayload = options?.mapPayload;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const key = `actions:${this.actionName}`;
    const payload = context.blackboard.get(key);

    if (payload === undefined) {
      return NodeStatus.FAILURE;
    }

    // Consume the action
    context.blackboard.delete(key);

    // Map payload if configured
    if (this.mapPayload) {
      this.mapPayload(payload, context.blackboard);
    }

    return NodeStatus.SUCCESS;
  }

  protected override computeHash(): string {
    return computeContentHash('ActionReceivedNode', this.actionName);
  }
}

/** Factory function. */
export function actionReceived(name: string, options?: ActionReceivedOptions): ActionReceivedNode {
  return new ActionReceivedNode(name, options);
}
```

Note: Verify that `blackboard.delete()` exists. If not, use `blackboard.set(key, undefined)` or check the Blackboard interface for the delete method.

Also verify that `ActionReceivedNode` is NOT detected as reactive by `isReactiveNode()`. Check `src/composites/` for how `isReactiveNode` works — it likely checks `instanceof ConditionNode` or `instanceof GuardNode`. Since `ActionReceivedNode` extends `BaseNode` directly, it should not match.

### Step 3: Run tests

Run: `npx vitest run src/nodes/action-received.test.ts`
Expected: All pass.

### Step 4: Typecheck + full suite

Run: `npm run typecheck && npm run test`

### Step 5: Commit

```bash
git add src/nodes/action-received.ts src/nodes/action-received.test.ts
git commit -m "feat(nodes): add actionReceived node for consuming action messages from blackboard"
```
