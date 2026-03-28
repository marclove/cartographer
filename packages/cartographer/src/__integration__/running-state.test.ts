import { describe, it, expect } from 'vitest';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { ParallelNode } from '../composites/parallel.js';
import { Repeat } from '../decorators/repeat.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';
import { createContext, countingAction } from './helpers.js';

describe('RUNNING State Management', () => {
  it('sequence caches completed children and skips re-ticking them', async () => {
    // a: action fn returns SUCCESS on first call
    // b: action fn returns SUCCESS on first call
    // With sync fast path, both resolve immediately in a single tick.
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

    // Single tick: a resolves sync → SUCCESS, b resolves sync → SUCCESS → seq SUCCESS
    expect(await sequence.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(1);
  });

  it('sequence RUNNING child is re-ticked until it resolves', async () => {
    // b's action fn returns RUNNING on first call, then SUCCESS on second call.
    // With sync fast path, both calls happen without inflight overhead.
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

    // Tick 1: a resolves sync → SUCCESS, b resolves sync → RUNNING → seq RUNNING
    expect(await sequence.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(1); // first call returns RUNNING

    // Tick 2: a cached, b called again sync → SUCCESS → seq SUCCESS
    expect(await sequence.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(a.getTicks()).toBe(1); // cached from first tick
    expect(b.getTicks()).toBe(2); // second call returns SUCCESS
  });

  it('selector resume with RUNNING then FAILURE falls back to next child', async () => {
    // a's action fn returns RUNNING on first call, FAILURE on second call.
    // b's action fn returns SUCCESS on first call.
    // With sync fast path, actions resolve immediately within a single tick.
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

    // Tick 1: a resolves sync → RUNNING → sel RUNNING (stops at a)
    expect(await selector.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(0);

    // Tick 2: a called again sync → FAILURE (cached), b resolves sync → SUCCESS → sel SUCCESS
    expect(await selector.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(a.getTicks()).toBe(2);
    expect(b.getTicks()).toBe(1);
  });

  it('nested composite: sequence > selector — resolves sync actions in a single tick', async () => {
    // a: SUCCESS, b (in selector): FAILURE, c (in selector): SUCCESS
    // With sync fast path, all resolve immediately.
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

    // Single tick: a → SUCCESS, selector: b → FAILURE, c → SUCCESS → sel SUCCESS → seq SUCCESS
    expect(await sequence.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(1);
    expect(c.getTicks()).toBe(1);
  });

  it('Repeat propagates RUNNING from child and restarts iteration on next tick', async () => {
    // Repeat(count=2): child returns RUNNING, SUCCESS, SUCCESS (sync).
    // With sync fast path, RUNNING is returned immediately, no inflight.
    const child = countingAction('child', [NodeStatus.RUNNING, NodeStatus.SUCCESS, NodeStatus.SUCCESS]);

    const repeat = new Repeat({
      name: 'repeat',
      child: new ActionNode(child.config),
      count: 2,
    });

    const ctx = createContext();

    // Tick 1: iteration 0, child called → RUNNING (sync) → repeat RUNNING
    expect(await repeat.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(child.getTicks()).toBe(1);

    // Tick 2: iteration 0, child called → SUCCESS (sync) → iteration 1,
    //   child called → SUCCESS (sync) → iteration 2 = count → repeat SUCCESS
    expect(await repeat.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(child.getTicks()).toBe(3);
  });

  it('parallel evaluates policy immediately when all sync children resolve', async () => {
    // All sync children resolve in a single tick.
    // Policy: failureCount(2), 2 failures >= 2 → FAILURE.
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

    // Single tick: all resolve sync → policy applied immediately → FAILURE
    expect(await parallel.tick(ctx)).toBe(NodeStatus.FAILURE);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(1);
    expect(c.getTicks()).toBe(1);
  });

  it('parallel resolves all sync children in a single tick', async () => {
    // Both sync children resolve immediately in a single tick.
    const a = countingAction('a', [NodeStatus.SUCCESS]);
    const b = countingAction('b', [NodeStatus.SUCCESS]);

    const parallel = new ParallelNode({
      name: 'par',
      children: [
        new ActionNode(a.config),
        new ActionNode(b.config),
      ],
    });

    const ctx = createContext();

    // Single tick: both resolve sync → default policy (all succeed) → SUCCESS
    expect(await parallel.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(a.getTicks()).toBe(1);
    expect(b.getTicks()).toBe(1);
  });
});
