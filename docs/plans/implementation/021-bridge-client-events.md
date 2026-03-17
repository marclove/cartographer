# Task 21: Bridge client:event to SSE Stream

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Forward `client:event` emissions from the tree's event emitter to the SSE stream so connected clients receive real-time events from `emitToClient` nodes.

**Architecture:** During `TreeActor.process()`, register a listener on `tree.events` for `client:event`. Collect emitted events, return them in `ProcessResult`. In `ActorServer.processAsync()`, append collected client events to the state store before the `message:processed` event so SSE clients see them in order.

**Tech Stack:** TypeScript, vitest

**Key files to understand:**
- `src/actor/tree-actor.ts` — `ProcessResult` interface (line 14), `process()` method (line 46)
- `src/server/actor-server.ts` — `processAsync()` method (line 173)
- `src/nodes/emit-to-client.ts` — emits `client:event` with `{ name, data }` shape
- `src/state/state-store.ts` — `TreeEvent` type, `appendEvents()` interface

---

### Step 1: Write the test

Create `src/__integration__/client-event-bridging.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { emitToClient } from '../application/emit-to-client.js';
import { NodeStatus } from '../types.js';
import { setupTest } from './helpers.js';

describe('client:event SSE bridging', () => {
  it('emitToClient events arrive via SSE', async () => {
    const receivedEvents: Array<{ name: string; data: unknown }> = [];

    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'emit-test',
          root: new SequenceNode({
            name: 'main',
            children: [
              new ActionNode({
                name: 'prepare',
                action: (ctx) => {
                  ctx.blackboard.set('greeting', 'hello world');
                  return NodeStatus.SUCCESS;
                },
              }),
              emitToClient('ui:message', (ctx) => ({
                text: ctx.blackboard.get('greeting'),
              })),
            ],
          }),
        }),
    });

    harness.client.on('ui:message', (data) => {
      receivedEvents.push({ name: 'ui:message', data });
    });

    await harness.client.actionAndWait('tick');

    // Give SSE a moment to deliver the event
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].data).toEqual({ text: 'hello world' });
  });

  it('multiple emitToClient events arrive in order', async () => {
    const receivedEvents: unknown[] = [];

    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'multi-emit',
          root: new SequenceNode({
            name: 'main',
            children: [
              emitToClient('ui:step', () => ({ step: 1 })),
              emitToClient('ui:step', () => ({ step: 2 })),
              emitToClient('ui:step', () => ({ step: 3 })),
            ],
          }),
        }),
    });

    harness.client.on('ui:step', (data) => {
      receivedEvents.push(data);
    });

    await harness.client.actionAndWait('tick');
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedEvents).toHaveLength(3);
    expect(receivedEvents).toEqual([{ step: 1 }, { step: 2 }, { step: 3 }]);
  });

  it('emitToClient also writes to blackboard (dual write)', async () => {
    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'dual-write',
          root: emitToClient('ui:status', () => ({ ready: true })),
        }),
    });

    await harness.client.actionAndWait('tick');
    const bb = await harness.client.blackboard();
    expect(bb['clientEvents:ui:status']).toEqual({ ready: true });
  });
});
```

### Step 2: Run the test to verify it fails

Run: `npm run test:integration -- client-event-bridging`
Expected: FAIL — `ui:message` event never arrives (0 events received)

### Step 3: Add `clientEvents` to ProcessResult

In `src/actor/tree-actor.ts`, add `clientEvents` to the `ProcessResult` interface (line 14):

```typescript
export interface ProcessResult {
  treeStatus: NodeStatus | 'error';
  error?: string;
  interrupted?: boolean;
  /** Returned when the tree is held and a tick was skipped. */
  held?: boolean;
  /** Client events emitted by emitToClient nodes during processing. */
  clientEvents?: Array<{ name: string; data: unknown }>;
}
```

### Step 4: Capture client:event in TreeActor.process()

In `src/actor/tree-actor.ts`, modify the `process()` method. After `const tree = this.createTree();` (line 47), add a listener to collect events. Return them in the result.

After line 47, add:
```typescript
const clientEvents: Array<{ name: string; data: unknown }> = [];
tree.events.on('client:event', (event) => {
  clientEvents.push(event as { name: string; data: unknown });
});
```

Modify the return statement (line 110) to include `clientEvents`:
```typescript
return { treeStatus, ...(interrupted && { interrupted: true }), clientEvents };
```

### Step 5: Append client events in ActorServer.processAsync()

In `src/server/actor-server.ts`, in the `processAsync()` method, after `const result = await actor.process(msg);` (line 197) and before the interrupt check (line 199), add:

```typescript
if (result.clientEvents && result.clientEvents.length > 0) {
  await this.stateStore.appendEvents('default', result.clientEvents.map((ce) => ({
    id: generateMessageId(),
    type: 'client:event',
    data: { name: ce.name, data: ce.data },
    timestamp: Date.now(),
  })));
}
```

### Step 6: Run the test to verify it passes

Run: `npm run test:integration -- client-event-bridging`
Expected: PASS — all 3 tests pass

### Step 7: Run all integration tests for regressions

Run: `npm run test:integration`
Expected: All tests pass

### Step 8: Run typecheck

Run: `npx tsc --noEmit`
Expected: No errors

### Step 9: Commit

```bash
git add src/actor/tree-actor.ts src/server/actor-server.ts src/__integration__/client-event-bridging.test.ts
git commit -m "feat: bridge client:event from tree emitter to SSE stream"
```
