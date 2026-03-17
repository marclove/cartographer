# Task 102: Add `onEvent` Callback to EventBridge

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an optional `onEvent` callback to EventBridge that fires for every event *as it arrives* (before buffering/flush), enabling real-time SSE broadcasting from ActorServer.

**Depends on:** None

---

### Context

EventBridge currently buffers all tree events during message processing and flushes them to StateStore only after processing completes. The dashboard needs real-time event streaming. Adding an `onEvent` callback lets ActorServer push events to its EventBuffer and broadcast to SSE clients immediately.

The callback should also fire for lifecycle events (`message:processed`, `message:interrupted`, `message:failed`).

### Files

- Modify: `src/server/event-bridge.ts`
- Modify: `src/server/event-bridge.test.ts` (or create if it doesn't exist)

---

- [ ] **Step 1: Write failing tests for `onEvent` callback**

In `src/server/event-bridge.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventBridge } from './event-bridge.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { TreeBuilder } from '../builder/tree-builder.js';
import { NodeStatus } from '../types.js';

describe('EventBridge onEvent callback', () => {
  function makeTree(): BehaviorTree {
    return new TreeBuilder('test')
      .action('a', () => NodeStatus.SUCCESS)
      .end()
      .build();
  }

  it('fires onEvent for tree events as they arrive', async () => {
    const store = new InMemoryStateStore();
    const received: Array<{ type: string; data: Record<string, unknown> }> = [];
    const bridge = new EventBridge(store, 'default', undefined, (evt) => {
      received.push(evt);
    });

    const tree = makeTree();
    bridge.bridgeTree(tree);
    await tree.tick();

    // Should have received events before flush
    expect(received.length).toBeGreaterThan(0);
    expect(received.some(e => e.type === 'node:enter')).toBe(true);
  });

  it('fires onEvent for lifecycle events', async () => {
    const store = new InMemoryStateStore();
    const received: Array<{ type: string; data: Record<string, unknown> }> = [];
    const bridge = new EventBridge(store, 'default', undefined, (evt) => {
      received.push(evt);
    });

    await bridge.emitProcessed('success');

    const lifecycle = received.filter(e => e.type === 'message:processed');
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0].data).toEqual(
      expect.objectContaining({ treeStatus: 'success' }),
    );
  });

  it('works without onEvent callback (backward compatible)', async () => {
    const store = new InMemoryStateStore();
    const bridge = new EventBridge(store, 'default');

    const tree = makeTree();
    bridge.bridgeTree(tree);
    await tree.tick();
    await bridge.emitProcessed('success');
    // No error thrown — callback is optional
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/event-bridge.test.ts`
Expected: FAIL — constructor doesn't accept 4th argument

- [ ] **Step 3: Implement `onEvent` callback**

Edit `src/server/event-bridge.ts`:

1. Add optional `onEvent` parameter to constructor:
```ts
constructor(
  private stateStore: StateStore,
  private stateKey: string,
  messageId?: string,
  private onEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
) {
  this.messageId = messageId ?? generateMessageId();
}
```

2. In `bridgeTree()`, call `onEvent` after pushing to buffer:
```ts
bridgeTree(tree: BehaviorTree): void {
  tree.events.onAny((type, data) => {
    const serialized = { type, data: serializeEvent(type as keyof TreeEvents, data as any) };
    this.buffer.push(serialized);
    this.onEvent?.(serialized);
  });
}
```

3. In `emitProcessed`, `emitInterrupted`, `emitFailed`, call `onEvent` for the lifecycle event:
```ts
async emitProcessed(treeStatus: string): Promise<void> {
  await this.flush();
  const event = { type: 'message:processed', data: { messageId: this.messageId, treeStatus } };
  this.onEvent?.(event);
  await this.stateStore.appendEvents(this.stateKey, [{
    id: generateEventId(),
    ...event,
    timestamp: Date.now(),
  }]);
}
```

Apply same pattern to `emitInterrupted` and `emitFailed`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/event-bridge.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite to verify no regressions**

Run: `npm run test`
Expected: All existing tests pass (constructor change is backward compatible)

- [ ] **Step 6: Commit**

```bash
git add src/server/event-bridge.ts src/server/event-bridge.test.ts
git commit -m "feat(event-bridge): add onEvent callback for real-time event broadcasting"
```
