import { describe, it, expect } from 'vitest';
import { SequenceNode } from './sequence.js';
import { SelectorNode } from './selector.js';
import { ParallelNode } from './parallel.js';
import { ActionNode } from '../nodes/action.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import { SessionRegistry } from '../core/session-registry.js';
import type { TreeEvents } from '../types.js';

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
    sessions: new SessionRegistry(),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('SequenceNode.interrupt()', () => {
  it('preserves completedMap — completed children are not re-executed', async () => {
    let callCountA = 0;
    let resolveB: (status: NodeStatus) => void;

    const childA = new ActionNode({
      name: 'child-a',
      action: () => { callCountA++; return NodeStatus.SUCCESS; },
    });
    const childB = new ActionNode({
      name: 'child-b',
      action: () => new Promise<NodeStatus>((r) => { resolveB = r; }),
    });

    const seq = new SequenceNode({
      name: 'test-seq',
      children: [childA, childB],
    });
    const ctx = createContext();

    // Tick 1: A succeeds (cached in completedMap), B starts async work
    await seq.tick(ctx);
    await flush();
    // Tick 2: A returns cached SUCCESS, B returns RUNNING (still in-flight)
    const status = await seq.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);
    expect(callCountA).toBe(1); // A was ticked once, then cached

    // Interrupt: clears B's inflight but preserves completedMap
    seq.interrupt();
    expect(childB.hasInflightWork()).toBe(false);

    // Tick 3 after interrupt: A should use cached result (not re-ticked),
    // B should restart fresh (new invocation since old promise was orphaned)
    const status3 = await seq.tick(ctx);
    expect(status3).toBe(NodeStatus.RUNNING); // B starts new work
    expect(callCountA).toBe(1); // A was NOT re-ticked

    // Cleanup
    resolveB!(NodeStatus.SUCCESS);
  });

  it('does not clear committedOrder on interrupt', async () => {
    let resolveA: (status: NodeStatus) => void;

    const childA = new ActionNode({
      name: 'child-a',
      action: () => new Promise<NodeStatus>((r) => { resolveA = r; }),
    });

    const seq = new SequenceNode({
      name: 'test-seq',
      children: [childA],
    });
    const ctx = createContext();

    // Tick to establish committedOrder
    await seq.tick(ctx);
    expect(seq.hasInflightWork()).toBe(true);

    // Interrupt
    seq.interrupt();
    expect(seq.hasInflightWork()).toBe(false);

    // Tree is still tickable — no reset needed
    const status = await seq.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING); // childA restarts

    // Cleanup
    resolveA!(NodeStatus.SUCCESS);
  });
});

describe('SelectorNode.interrupt()', () => {
  it('preserves completedMap — failed children are not re-ticked', async () => {
    let callCountA = 0;
    let resolveB: (status: NodeStatus) => void;

    const childA = new ActionNode({
      name: 'child-a',
      action: () => { callCountA++; return NodeStatus.FAILURE; },
    });
    const childB = new ActionNode({
      name: 'child-b',
      action: () => new Promise<NodeStatus>((r) => { resolveB = r; }),
    });

    const sel = new SelectorNode({
      name: 'test-sel',
      children: [childA, childB],
    });
    const ctx = createContext();

    // Tick 1: A fails (cached), B starts async work
    await sel.tick(ctx);
    await flush();
    // Tick 2: A returns cached FAILURE, B returns RUNNING
    const status = await sel.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);
    expect(callCountA).toBe(1);

    // Interrupt: clears B's inflight, preserves completedMap
    sel.interrupt();
    expect(childB.hasInflightWork()).toBe(false);

    // Tick 3: A uses cached FAILURE (not re-ticked), B restarts
    const status3 = await sel.tick(ctx);
    expect(status3).toBe(NodeStatus.RUNNING);
    expect(callCountA).toBe(1); // A was NOT re-ticked

    // Cleanup
    resolveB!(NodeStatus.SUCCESS);
  });
});

describe('ParallelNode.interrupt()', () => {
  it('preserves completedMap — completed children are not re-ticked', async () => {
    let callCountA = 0;
    let resolveB: (status: NodeStatus) => void;

    const childA = new ActionNode({
      name: 'child-a',
      action: () => { callCountA++; return NodeStatus.SUCCESS; },
    });
    const childB = new ActionNode({
      name: 'child-b',
      action: () => new Promise<NodeStatus>((r) => { resolveB = r; }),
    });

    const par = new ParallelNode({
      name: 'test-par',
      children: [childA, childB],
    });
    const ctx = createContext();

    // Tick 1: A succeeds (cached), B starts async work → RUNNING
    await par.tick(ctx);
    await flush();
    // Tick 2: A returns cached SUCCESS, B returns RUNNING
    const status = await par.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);
    expect(callCountA).toBe(1);

    // Interrupt
    par.interrupt();
    expect(childB.hasInflightWork()).toBe(false);

    // Tick 3: A should use cached SUCCESS, B restarts
    const status3 = await par.tick(ctx);
    expect(status3).toBe(NodeStatus.RUNNING);
    expect(callCountA).toBe(1); // A was NOT re-ticked

    // Cleanup
    resolveB!(NodeStatus.SUCCESS);
  });
});
