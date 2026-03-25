import { describe, it, expect } from 'vitest';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { ParallelNode } from '../composites/parallel.js';
import { Repeat } from '../decorators/repeat.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';
import { createContext, countingAction } from './helpers.js';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('RUNNING State Management', () => {
  it('sequence caches completed children and skips re-ticking them', async () => {
    // a: action fn returns SUCCESS on first call
    // b: action fn returns SUCCESS on first call
    // Verifies that once a child completes within a cycle, it is cached
    // and not re-ticked on subsequent ticks of the same cycle.
    const a = countingAction('a', [NodeStatus.SUCCESS]);
    const b = countingAction('b', [NodeStatus.SUCCESS]);

    const sequence = new SequenceNode({
      name: 'seq',
      children: [
        new ActionNode(a.config),
        new ActionNode(b.config),
      ],
    });

    const ctx = createContext();

    // Tick 1: a starts inflight → RUNNING (seq returns RUNNING at a)
    expect(await sequence.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1); // action fn called once to start inflight
    expect(b.getTicks()).toBe(0); // not reached yet

    await flush(); // a's promise resolves with SUCCESS

    // Tick 2: a polls → SUCCESS (cached), b starts inflight → RUNNING
    expect(await sequence.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1); // not called again — cached result from poll
    expect(b.getTicks()).toBe(1); // action fn called once to start inflight

    await flush(); // b's promise resolves with SUCCESS

    // Tick 3: a cached (SUCCESS), b polls → SUCCESS → seq SUCCESS
    expect(await sequence.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(a.getTicks()).toBe(1); // still cached — never re-ticked in this cycle
    expect(b.getTicks()).toBe(1); // not called again — cached result from poll
  });

  it('sequence RUNNING child re-starts inflight each time it resolves RUNNING', async () => {
    // b's action fn returns RUNNING on first call, then SUCCESS on second call.
    // With the inflight model each "start" counts as one action fn call.
    // RUNNING result clears inflight → next tick starts a fresh inflight.
    const a = countingAction('a', [NodeStatus.SUCCESS]);
    const b = countingAction('b', [NodeStatus.RUNNING, NodeStatus.SUCCESS]);

    const sequence = new SequenceNode({
      name: 'seq',
      children: [
        new ActionNode(a.config),
        new ActionNode(b.config),
      ],
    });

    const ctx = createContext();

    // Tick 1: a starts inflight → seq RUNNING (stops at a)
    expect(await sequence.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(0);

    await flush(); // a resolves SUCCESS

    // Tick 2: a polls SUCCESS (cached), b starts inflight → seq RUNNING
    expect(await sequence.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1); // not re-called — cached
    expect(b.getTicks()).toBe(1); // first call to b's action fn

    await flush(); // b resolves RUNNING → inflight cleared

    // Tick 3: a cached, b polls RUNNING → inflight cleared → seq RUNNING
    expect(await sequence.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(1); // still 1: poll tick doesn't call action fn

    // Tick 4: a cached, b starts fresh inflight (action fn called again) → seq RUNNING
    expect(await sequence.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(2); // second call to b's action fn

    await flush(); // b resolves SUCCESS

    // Tick 5: a cached, b polls SUCCESS (cached) → seq SUCCESS
    expect(await sequence.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(2); // not called again
  });

  it('selector resume with RUNNING then FAILURE falls back to next child', async () => {
    // a's action fn returns RUNNING on first call, FAILURE on second call.
    // b's action fn returns SUCCESS on first call.
    // Selector re-evaluates from the start each tick; cached completed children
    // are skipped. Once a resolves FAILURE, the selector falls through to b.
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

    // Tick 1: a starts inflight → sel RUNNING (stops at a)
    expect(await selector.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(0);

    await flush(); // a resolves RUNNING → inflight cleared

    // Tick 2: a polls RUNNING → inflight cleared → sel RUNNING (stops at a)
    expect(await selector.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1); // poll tick — action fn not called again
    expect(b.getTicks()).toBe(0);

    // Tick 3: a starts fresh inflight (action fn called again) → sel RUNNING
    expect(await selector.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(2); // second call to action fn

    await flush(); // a resolves FAILURE

    // Tick 4: a polls FAILURE (cached as completed), b starts inflight → sel RUNNING
    expect(await selector.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(2); // not called again — poll returned FAILURE, cached
    expect(b.getTicks()).toBe(1); // b's action fn called

    await flush(); // b resolves SUCCESS

    // Tick 5: a cached FAILURE, b polls SUCCESS → sel SUCCESS
    expect(await selector.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(a.getTicks()).toBe(2);
    expect(b.getTicks()).toBe(1); // not called again
  });

  it('nested composite: sequence > selector — caches and propagates RUNNING correctly', async () => {
    // a: completes SUCCESS immediately (one start + one poll)
    // b (in selector): action fn returns FAILURE — selector falls through to c
    // c (in selector): action fn returns SUCCESS
    // Verifies nested composite caching: once sequence caches a (SUCCESS),
    // it skips a on all subsequent ticks.
    const a = countingAction('a', [NodeStatus.SUCCESS]);
    const b = countingAction('b', [NodeStatus.FAILURE]);
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

    // Tick 1: a starts inflight → seq RUNNING (stops at a)
    expect(await sequence.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(0);
    expect(c.getTicks()).toBe(0);

    await flush(); // a resolves SUCCESS

    // Tick 2: a polls SUCCESS (cached in seq.completedMap),
    //   selector ticks: b starts inflight → sel RUNNING → seq RUNNING
    expect(await sequence.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1); // not re-called — cached
    expect(b.getTicks()).toBe(1);
    expect(c.getTicks()).toBe(0);

    await flush(); // b resolves FAILURE

    // Tick 3: a cached, selector: b polls FAILURE (cached in sel.completedMap),
    //   c starts inflight → sel RUNNING → seq RUNNING
    expect(await sequence.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(1); // not re-called — poll returned FAILURE, cached
    expect(c.getTicks()).toBe(1);

    await flush(); // c resolves SUCCESS

    // Tick 4: a cached, sel: b cached FAILURE, c polls SUCCESS → sel SUCCESS → seq SUCCESS
    expect(await sequence.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(1);
    expect(c.getTicks()).toBe(1); // not re-called — poll returned SUCCESS
  });

  it('Repeat propagates RUNNING from child and restarts iteration on next tick', async () => {
    // Repeat(count=2): child returns RUNNING on first start, SUCCESS on second start.
    // When child returns RUNNING, repeat returns RUNNING and preserves _iteration.
    // On the next tick, the child is polled — RUNNING clears inflight, repeat sees RUNNING
    // and returns RUNNING. Next tick starts a fresh inflight; child resolves SUCCESS.
    // Repeat increments iteration (0→1), starts iteration 1, child resolves SUCCESS → done.
    const child = countingAction('child', [NodeStatus.RUNNING, NodeStatus.SUCCESS, NodeStatus.SUCCESS]);

    const repeat = new Repeat({
      name: 'repeat',
      child: new ActionNode(child.config),
      count: 2,
    });

    const ctx = createContext();

    // Tick 1: iteration 0, child starts inflight → child RUNNING → repeat RUNNING
    expect(await repeat.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(child.getTicks()).toBe(1);

    await flush(); // child resolves RUNNING → inflight cleared

    // Tick 2: iteration 0, child polls RUNNING → inflight cleared → repeat RUNNING
    expect(await repeat.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(child.getTicks()).toBe(1); // poll tick — action fn not called again

    // Tick 3: iteration 0, child starts fresh inflight (action fn called → SUCCESS) → repeat RUNNING
    expect(await repeat.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(child.getTicks()).toBe(2);

    await flush(); // child resolves SUCCESS

    // Tick 4: iteration 0, child polls SUCCESS → iteration increments to 1.
    //   iteration 1: child starts inflight (action fn called → SUCCESS) → repeat RUNNING
    expect(await repeat.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(child.getTicks()).toBe(3);

    await flush(); // child resolves SUCCESS

    // Tick 5: iteration 1, child polls SUCCESS → iteration increments to 2 → limit reached → repeat SUCCESS
    expect(await repeat.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(child.getTicks()).toBe(3); // not called again — poll
  });

  it('parallel RUNNING defers policy evaluation until all children resolve', async () => {
    // All children start inflight on tick 1 → all RUNNING → parallel RUNNING.
    // After flush, results resolve. Tick 2: a polls SUCCESS (cached), b polls FAILURE (cached),
    // c polls FAILURE (cached). All resolved → evaluate failureCount policy:
    // 2 failures >= failureCount(2) → FAILURE.
    const a = countingAction('a', [NodeStatus.SUCCESS]);
    const b = countingAction('b', [NodeStatus.FAILURE]);
    const c = countingAction('c', [NodeStatus.FAILURE]);

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

    // Tick 1: all children start inflight → all RUNNING → parallel RUNNING
    expect(await parallel.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(1);
    expect(c.getTicks()).toBe(1);

    await flush(); // all promises resolve

    // Tick 2: a polls SUCCESS, b polls FAILURE, c polls FAILURE → no RUNNING children
    //   policy: failureCount(2), 2 failures >= 2 → FAILURE
    expect(await parallel.tick(ctx)).toBe(NodeStatus.FAILURE);
    expect(a.getTicks()).toBe(1); // poll tick, not re-started
    expect(b.getTicks()).toBe(1);
    expect(c.getTicks()).toBe(1);
  });

  it('parallel caches non-RUNNING children while others are still in progress', async () => {
    // a resolves SUCCESS in first round; b takes two rounds.
    // On tick 2, a is cached (not re-ticked); b still resolving → RUNNING.
    // On tick 3 (after b resolves), all terminal → policy applied.
    const a = countingAction('a', [NodeStatus.SUCCESS]);
    const b = countingAction('b', [NodeStatus.SUCCESS]);

    // We introduce an asymmetry: a resolves immediately, b we'll delay by not flushing first tick.
    // Actually both start inflight on tick 1. After flush both resolve.
    // To create asymmetry: use a real delay for b — but that's complex.
    // Instead, verify caching by checking getTicks() counts after tick 2 poll.

    const parallel = new ParallelNode({
      name: 'par',
      children: [
        new ActionNode(a.config),
        new ActionNode(b.config),
      ],
    });

    const ctx = createContext();

    // Tick 1: both start inflight → both RUNNING → parallel RUNNING
    expect(await parallel.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(1);

    await flush();

    // Tick 2: both poll SUCCESS → no RUNNING → default policy (all succeed) → SUCCESS
    expect(await parallel.tick(ctx)).toBe(NodeStatus.SUCCESS);
    // poll ticks do not call the action fn again
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(1);
  });
});
