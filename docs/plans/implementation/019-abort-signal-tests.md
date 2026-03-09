# Task 19: Abort Signal Integration Tests

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Test abort propagation through sequences, parallels, decorators, scheduler, and async actions using AbortSignal.

**Architecture:** 5 deterministic integration tests in a single file. Uses `AbortTrackingNode` from helpers for tracking abort calls, `ActionNode` for behavior, and `BehaviorTree` for signal-based abort.

**Tech Stack:** TypeScript, vitest

---

### Step 1: Create abort-signal.test.ts with all 5 tests

Create `src/__integration__/abort-signal.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { ParallelNode } from '../composites/parallel.js';
import { RetryNode } from '../decorators/retry.js';
import { TreeScheduler } from '../scheduler/tree-scheduler.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { createContext, AbortTrackingNode, collectEvents } from './helpers.js';

describe('Abort Signal Integration', () => {
  it('aborts sequence mid-RUNNING — second child never ticks', async () => {
    let secondChildTicks = 0;

    const first = new ActionNode({
      name: 'first',
      action: () => NodeStatus.RUNNING,
    });

    const second = new ActionNode({
      name: 'second',
      action: () => {
        secondChildTicks++;
        return NodeStatus.SUCCESS;
      },
    });

    const sequence = new SequenceNode({
      name: 'seq',
      children: [first, second],
    });

    const ctx = createContext();

    // First tick: first child returns RUNNING, sequence returns RUNNING
    const status = await sequence.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);

    // Abort the sequence
    sequence.abort();

    // Second child should never have been ticked
    expect(secondChildTicks).toBe(0);
  });

  it('aborts parallel — all children receive abort', async () => {
    const children = [
      new AbortTrackingNode('child-1'),
      new AbortTrackingNode('child-2'),
      new AbortTrackingNode('child-3'),
    ];

    const parallel = new ParallelNode({
      name: 'par',
      children,
    });

    const ctx = createContext();
    const status = await parallel.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);

    parallel.abort();

    for (const child of children) {
      expect(child.aborted).toBe(true);
    }
  });

  it('aborts through decorators — retry stops retrying', async () => {
    const tracker = new AbortTrackingNode('inner');

    const retry = new RetryNode({
      name: 'retry',
      child: tracker,
      maxAttempts: 5,
    });

    const ctx = createContext();

    // RetryNode: child returns RUNNING, retry returns RUNNING (not FAILURE, so no retry loop)
    const status = await retry.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);

    retry.abort();
    expect(tracker.aborted).toBe(true);
  });

  it('abort with scheduler — scheduler.stop() fires manual stop event', async () => {
    const tree = new BehaviorTree({
      name: 'scheduler-abort',
      root: new ActionNode({
        name: 'slow',
        action: () => NodeStatus.RUNNING,
      }),
    });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', ms: 10 },
    });

    const stopEvents = collectEvents(
      { blackboard: tree.blackboard, events: scheduler.events as any } as any,
      'scheduler:stop' as any,
    );

    // Start scheduler in background, stop after first tick
    const startPromise = scheduler.start();

    // Give it time for one tick
    await new Promise((r) => setTimeout(r, 50));

    await scheduler.stop();
    await startPromise;

    expect(scheduler.isRunning).toBe(false);
    // Check stop event directly on scheduler events
    const schedulerStopEvents: unknown[] = [];
    // Re-check: we need to collect events before starting
  });

  it('AbortSignal in async actions — action respects ctx.signal', async () => {
    let loopIterations = 0;

    const tree = new BehaviorTree({
      name: 'signal-test',
      root: new ActionNode({
        name: 'signal-aware',
        action: async (ctx) => {
          // Simulate async work that checks the signal
          while (!ctx.signal?.aborted) {
            loopIterations++;
            await new Promise((r) => setTimeout(r, 10));
            if (loopIterations >= 10) break; // safety limit
          }
          return ctx.signal?.aborted ? NodeStatus.FAILURE : NodeStatus.SUCCESS;
        },
      }),
    });

    // Start tick in background, abort after short delay
    const tickPromise = tree.tick();
    await new Promise((r) => setTimeout(r, 35));
    tree.abort();

    const status = await tickPromise;
    expect(status).toBe(NodeStatus.FAILURE);
    expect(loopIterations).toBeGreaterThan(0);
    expect(loopIterations).toBeLessThan(10);
  });
});
```

**Note:** Test 4 (scheduler abort) needs the stop event collected before `start()`. Revise test 4 to:

```typescript
  it('abort with scheduler — scheduler.stop() fires manual stop event', async () => {
    const tree = new BehaviorTree({
      name: 'scheduler-abort',
      root: new ActionNode({
        name: 'slow',
        action: () => NodeStatus.RUNNING,
      }),
    });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', ms: 10 },
    });

    const stopEvents: unknown[] = [];
    scheduler.events.on('scheduler:stop', (data) => stopEvents.push(data));

    // Start scheduler in background, stop after first tick
    const startPromise = scheduler.start();
    await new Promise((r) => setTimeout(r, 50));

    await scheduler.stop();
    await startPromise;

    expect(scheduler.isRunning).toBe(false);
    expect(stopEvents).toHaveLength(1);
    expect((stopEvents[0] as any).reason).toBe('manual');
  });
```

Use this corrected version for test 4 in the final file.

### Step 2: Run tests to verify they pass

Run: `npx vitest run src/__integration__/abort-signal.test.ts`
Expected: PASS — all 5 tests pass.

### Step 3: Run all tests to verify no regressions

Run: `npm run test`
Expected: All unit tests pass.

### Step 4: Commit

```bash
git add src/__integration__/abort-signal.test.ts
git commit -m "test: add abort signal integration tests"
```
