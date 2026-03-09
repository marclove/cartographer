# Task 21: RUNNING State Integration Tests

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Test RUNNING state management across composite resume, nested trees, decorator wrapping, and parallel failure policies.

**Architecture:** 5 deterministic integration tests verifying tick counts and status transitions across multi-tick scenarios. Uses `countingAction` from helpers to track per-node tick counts.

**Tech Stack:** TypeScript, vitest

**Key implementation details to understand:**
- `SequenceNode` and `SelectorNode` store `runningChildId` and resume from that child on subsequent ticks (see `src/composites/sequence.ts:21-26`)
- `RepeatNode` does NOT track iteration count across ticks — when child returns RUNNING, repeat returns RUNNING and restarts from iteration 0 on next tick (see `src/decorators/repeat.ts:17-33`)
- `ParallelNode` checks RUNNING before policies — `failureCount` is only evaluated when no children are RUNNING (see `src/composites/parallel.ts:20-21`)

---

### Step 1: Create running-state.test.ts

Create `src/__integration__/running-state.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { ParallelNode } from '../composites/parallel.js';
import { RepeatNode } from '../decorators/repeat.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';
import { createContext, countingAction } from './helpers.js';

describe('RUNNING State Management', () => {
  it('sequence resume skips completed children', async () => {
    const a = countingAction('a', [NodeStatus.SUCCESS]);
    const b = countingAction('b', [NodeStatus.RUNNING, NodeStatus.RUNNING, NodeStatus.SUCCESS]);
    const c = countingAction('c', [NodeStatus.SUCCESS]);

    const sequence = new SequenceNode({
      name: 'seq',
      children: [
        new ActionNode(a.config),
        new ActionNode(b.config),
        new ActionNode(c.config),
      ],
    });

    const ctx = createContext();

    // Tick 1: A=SUCCESS, B=RUNNING → seq RUNNING
    expect(await sequence.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(1);
    expect(c.getTicks()).toBe(0);

    // Tick 2: resumes at B, B=RUNNING → seq RUNNING (A skipped)
    expect(await sequence.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1); // not re-ticked
    expect(b.getTicks()).toBe(2);
    expect(c.getTicks()).toBe(0);

    // Tick 3: resumes at B, B=SUCCESS, C=SUCCESS → seq SUCCESS
    expect(await sequence.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(3);
    expect(c.getTicks()).toBe(1);
  });

  it('selector resume with RUNNING then FAILURE falls back', async () => {
    const a = countingAction('a', [NodeStatus.RUNNING, NodeStatus.FAILURE]);
    const b = countingAction('b', [NodeStatus.SUCCESS]);

    const selector = new SelectorNode({
      name: 'sel',
      children: [
        new ActionNode(a.config),
        new ActionNode(b.config),
      ],
    });

    const ctx = createContext();

    // Tick 1: A=RUNNING → sel RUNNING
    expect(await selector.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(0);

    // Tick 2: resumes at A, A=FAILURE, falls to B, B=SUCCESS → sel SUCCESS
    expect(await selector.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(a.getTicks()).toBe(2);
    expect(b.getTicks()).toBe(1);
  });

  it('nested composite resume — sequence > selector > RUNNING action', async () => {
    const a = countingAction('a', [NodeStatus.SUCCESS]);
    const b = countingAction('b', [NodeStatus.RUNNING, NodeStatus.RUNNING, NodeStatus.FAILURE]);
    const c = countingAction('c', [NodeStatus.SUCCESS]);

    const selector = new SelectorNode({
      name: 'inner-sel',
      children: [
        new ActionNode(b.config),
        new ActionNode(c.config),
      ],
    });

    const sequence = new SequenceNode({
      name: 'outer-seq',
      children: [
        new ActionNode(a.config),
        selector,
      ],
    });

    const ctx = createContext();

    // Tick 1: A=SUCCESS, selector starts B=RUNNING → seq RUNNING
    expect(await sequence.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(1);
    expect(c.getTicks()).toBe(0);

    // Tick 2: seq resumes at selector, selector resumes at B, B=RUNNING → seq RUNNING
    expect(await sequence.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1); // skipped
    expect(b.getTicks()).toBe(2);
    expect(c.getTicks()).toBe(0);

    // Tick 3: seq resumes at selector, selector resumes at B, B=FAILURE, falls to C, C=SUCCESS → seq SUCCESS
    expect(await sequence.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(3);
    expect(c.getTicks()).toBe(1);
  });

  it('decorator-wrapped RUNNING — RepeatNode restarts iteration on resume', async () => {
    // RepeatNode(count=2) does NOT track iteration across ticks.
    // When child returns RUNNING, repeat returns RUNNING.
    // On next tick, repeat restarts from iteration 0.
    const child = countingAction('child', [
      NodeStatus.RUNNING, // tick 1: iteration 0 → RUNNING
      NodeStatus.SUCCESS, // tick 2: iteration 0 → SUCCESS, then iteration 1...
      NodeStatus.SUCCESS, // tick 2 continued: iteration 1 → SUCCESS → repeat done
    ]);

    const repeat = new RepeatNode({
      name: 'repeat',
      child: new ActionNode(child.config),
      count: 2,
    });

    const ctx = createContext();

    // Tick 1: child RUNNING → repeat RUNNING
    expect(await repeat.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(child.getTicks()).toBe(1);

    // Tick 2: repeat restarts, iteration 0: child SUCCESS, iteration 1: child SUCCESS → repeat SUCCESS
    expect(await repeat.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(child.getTicks()).toBe(3);
  });

  it('parallel RUNNING with failureCount policy — RUNNING blocks policy check', async () => {
    // ParallelNode checks RUNNING before policies.
    // failureCount is only evaluated when no children are RUNNING.
    const a = countingAction('a', [NodeStatus.SUCCESS, NodeStatus.SUCCESS]);
    const b = countingAction('b', [NodeStatus.RUNNING, NodeStatus.FAILURE]);
    const c = countingAction('c', [NodeStatus.RUNNING, NodeStatus.FAILURE]);

    const parallel = new ParallelNode({
      name: 'par',
      children: [
        new ActionNode(a.config),
        new ActionNode(b.config),
        new ActionNode(c.config),
      ],
      strategy: new DefaultParallelStrategy({ failureCount: 2 }),
    });

    const ctx = createContext();

    // Tick 1: A=SUCCESS, B=RUNNING, C=RUNNING → RUNNING (policy not checked)
    expect(await parallel.tick(ctx)).toBe(NodeStatus.RUNNING);

    // Tick 2: A=SUCCESS, B=FAILURE, C=FAILURE → 2 failures >= failureCount → FAILURE
    expect(await parallel.tick(ctx)).toBe(NodeStatus.FAILURE);
    expect(a.getTicks()).toBe(2);
    expect(b.getTicks()).toBe(2);
    expect(c.getTicks()).toBe(2);
  });
});
```

### Step 2: Run tests to verify they pass

Run: `npx vitest run src/__integration__/running-state.test.ts`
Expected: PASS — all 5 tests pass.

### Step 3: Run all tests to verify no regressions

Run: `npm run test`
Expected: All unit tests pass.

### Step 4: Commit

```bash
git add src/__integration__/running-state.test.ts
git commit -m "test: add RUNNING state management integration tests"
```
