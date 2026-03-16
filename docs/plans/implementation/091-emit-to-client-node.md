# Task 91: emitToClient Node + TreeEvents Additions

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the `emitToClient()` action factory that performs a dual write (blackboard + event), and add the new event types to TreeEvents.

**Depends on:** None

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 6 (emitToClient), Section 12 (TreeEvents modifications)

---

### Context

`emitToClient` performs a dual write:
1. Writes the payload to `clientEvents:<name>` on the blackboard (durable record).
2. Emits a `'client:event'` event via the event system (real-time SSE delivery).

Also adds `'message:processed'` and `'message:failed'` event types to TreeEvents.

### Step 1: Add new event types to TreeEvents

Edit `src/types.ts` — add to the `TreeEvents` interface:

```ts
'client:event': { name: string; data: unknown };
'message:processed': { messageId: string; treeStatus: string };
'message:failed': { messageId: string; error: string };
```

### Step 2: Write failing tests

Create `src/nodes/emit-to-client.test.ts`:

```ts
describe('EmitToClientNode', () => {
  it('writes payload to blackboard under clientEvents: namespace', async () => {
    const node = emitToClient('ui:show_review', (ctx) => ({
      findings: 'some data',
    }));
    const ctx = createTestContext();

    await node.tick(ctx);
    // ActionNode polling model: first tick starts, second collects
    await new Promise(r => setTimeout(r, 0));
    await node.tick(ctx);

    expect(ctx.blackboard.get('clientEvents:ui:show_review')).toEqual({
      findings: 'some data',
    });
  });

  it('emits client:event through the event system', async () => {
    const node = emitToClient('ui:show_review', () => ({ findings: 'data' }));
    const ctx = createTestContext();
    const events: Array<{ name: string; data: unknown }> = [];
    ctx.events.on('client:event', (e) => events.push(e));

    await node.tick(ctx);
    await new Promise(r => setTimeout(r, 0));
    await node.tick(ctx);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ name: 'ui:show_review', data: { findings: 'data' } });
  });

  it('returns SUCCESS after emitting', async () => {
    const node = emitToClient('test', () => ({}));
    const ctx = createTestContext();

    await node.tick(ctx);
    await new Promise(r => setTimeout(r, 0));
    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.SUCCESS);
  });

  it('receives TreeContext in the data function', async () => {
    const node = emitToClient('test', (ctx) => ({
      value: ctx.blackboard.get('some:key'),
    }));
    const ctx = createTestContext();
    ctx.blackboard.set('some:key', 42);

    await node.tick(ctx);
    await new Promise(r => setTimeout(r, 0));
    await node.tick(ctx);

    expect(ctx.blackboard.get('clientEvents:test')).toEqual({ value: 42 });
  });

  it('produces stable content hash', () => {
    const a = emitToClient('ui:review', () => ({}));
    const b = emitToClient('ui:review', () => ({}));
    expect(a.contentHash()).toBe(b.contentHash());
  });
});
```

### Step 3: Implement EmitToClientNode

Create `src/nodes/emit-to-client.ts`:

```ts
import { ActionNode } from './action.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { computeContentHash } from '../core/content-hash.js';

/**
 * Emits structured data to the client via dual write:
 * 1. Blackboard entry at `clientEvents:<name>` (durable)
 * 2. `client:event` event (real-time SSE)
 */
export class EmitToClientNode extends ActionNode {
  private readonly eventName: string;
  private readonly dataFn: (ctx: TreeContext) => unknown;

  constructor(eventName: string, dataFn: (ctx: TreeContext) => unknown) {
    super({
      name: `emitToClient:${eventName}`,
      action: async (ctx: TreeContext) => {
        const data = dataFn(ctx);
        ctx.blackboard.set(`clientEvents:${eventName}`, data);
        ctx.events.emit('client:event', { name: eventName, data });
        return NodeStatus.SUCCESS;
      },
    });
    this.eventName = eventName;
    this.dataFn = dataFn;
  }

  protected override computeHash(): string {
    return computeContentHash('EmitToClientNode', this.eventName);
  }
}

/** Factory function. */
export function emitToClient(
  name: string,
  dataFn: (ctx: TreeContext) => unknown,
): EmitToClientNode {
  return new EmitToClientNode(name, dataFn);
}
```

Note: `EmitToClientNode` extends `ActionNode` to get the inflight polling model. The action function is provided in the constructor. Check that ActionNode's constructor accepts an action function and that `ctx` (TreeContext) is passed to it.

### Step 4: Run tests

Run: `npx vitest run src/nodes/emit-to-client.test.ts`
Expected: All pass.

### Step 5: Typecheck + full suite

Run: `npm run typecheck && npm run test`

### Step 6: Commit

```bash
git add src/types.ts src/nodes/emit-to-client.ts src/nodes/emit-to-client.test.ts
git commit -m "feat(nodes): add emitToClient node with dual blackboard+event write, add new TreeEvents entries"
```
