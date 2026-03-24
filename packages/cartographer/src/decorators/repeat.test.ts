import { describe, it, expect, vi } from 'vitest';
import { RepeatNode } from './repeat.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';
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

function mockChild(status: NodeStatus): BTreeNode {
  return {
    id: 'child', name: 'child',
    tick: vi.fn(async () => status),
    reset: vi.fn(), abort: vi.fn(),
  };
}

function dynamicChild(statuses: NodeStatus[]): BTreeNode {
  let call = 0;
  return {
    id: 'child', name: 'child',
    tick: vi.fn(async () => statuses[call++] ?? NodeStatus.FAILURE),
    reset: vi.fn(), abort: vi.fn(),
  };
}

describe('RepeatNode instance field persistence', () => {
  it('iteration counter persists across ticks when child returns RUNNING', async () => {
    // iteration 0: SUCCESS, iteration 1: RUNNING (persists), iteration 1 resumes: SUCCESS, iteration 2: SUCCESS => done
    const child = dynamicChild([
      NodeStatus.SUCCESS,  // iteration 0 completes
      NodeStatus.RUNNING,  // iteration 1 returns RUNNING
      NodeStatus.SUCCESS,  // iteration 1 resumes, completes
      NodeStatus.SUCCESS,  // iteration 2 completes => done (count=3)
    ]);
    const node = new RepeatNode({ name: 'rep', child, count: 3 });
    const ctx = createContext();

    // Tick 1: iteration 0 succeeds, iteration 1 returns RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(child.tick).toHaveBeenCalledTimes(2);

    // Tick 2: resumes at iteration 1 (succeeds), iteration 2 succeeds => done
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(4);
  });

  it('after child resolves from RUNNING, repeat continues from correct iteration', async () => {
    // With count=4: iter 0 ok, iter 1 RUNNING, iter 1 resumes ok, iter 2 ok, iter 3 ok
    const child = dynamicChild([
      NodeStatus.SUCCESS,  // iteration 0
      NodeStatus.RUNNING,  // iteration 1 RUNNING
      NodeStatus.SUCCESS,  // iteration 1 resumes
      NodeStatus.SUCCESS,  // iteration 2
      NodeStatus.SUCCESS,  // iteration 3 => done
    ]);
    const node = new RepeatNode({ name: 'rep', child, count: 4 });
    const ctx = createContext();

    // Tick 1: iteration 0 ok, iteration 1 RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(child.tick).toHaveBeenCalledTimes(2);

    // Tick 2: resumes at iteration 1, then 2 and 3 complete
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(5);
  });

  it('reset() clears the iteration counter', async () => {
    const child = dynamicChild([
      NodeStatus.SUCCESS,  // iteration 0
      NodeStatus.RUNNING,  // iteration 1 RUNNING
      // after reset, counter goes back to 0
      NodeStatus.SUCCESS,  // iteration 0
      NodeStatus.SUCCESS,  // iteration 1
      NodeStatus.SUCCESS,  // iteration 2 => done (count=3)
    ]);
    const node = new RepeatNode({ name: 'rep', child, count: 3 });
    const ctx = createContext();

    // Tick 1: iteration 0 ok, iteration 1 RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);

    // Reset clears the counter
    node.reset();

    // Tick 2: starts from iteration 0 again
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(5);
  });

  it('abort() clears the iteration counter', async () => {
    const child = dynamicChild([
      NodeStatus.SUCCESS,  // iteration 0
      NodeStatus.RUNNING,  // iteration 1 RUNNING
      // after abort, counter goes back to 0
      NodeStatus.SUCCESS,  // iteration 0
      NodeStatus.SUCCESS,  // iteration 1
      NodeStatus.SUCCESS,  // iteration 2 => done (count=3)
    ]);
    const node = new RepeatNode({ name: 'rep', child, count: 3 });
    const ctx = createContext();

    // Tick 1: iteration 0 ok, iteration 1 RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);

    // Abort clears the counter
    node.abort();

    // Tick 2: starts from iteration 0 again
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(5);
  });

  it('counter resets when repeat completes', async () => {
    const child = dynamicChild([
      // First run: count=2
      NodeStatus.SUCCESS,
      NodeStatus.SUCCESS,
      // Second run: should start from iteration 0 again
      NodeStatus.SUCCESS,
      NodeStatus.SUCCESS,
    ]);
    const node = new RepeatNode({ name: 'rep', child, count: 2 });
    const ctx = createContext();

    // First complete run
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(2);

    // Counter should have reset — next tick starts from iteration 0
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(4);
  });
});

describe('RepeatNode', () => {
  it('repeats child N times', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new RepeatNode({ name: 'rep', child, count: 3 });
    const status = await node.tick(createContext());
    expect(status).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(3);
  });

  it('stops early when child returns target status', async () => {
    const child = dynamicChild([NodeStatus.SUCCESS, NodeStatus.FAILURE, NodeStatus.SUCCESS]);
    const node = new RepeatNode({ name: 'rep', child, count: 10, untilStatus: NodeStatus.FAILURE });
    const status = await node.tick(createContext());
    expect(status).toBe(NodeStatus.FAILURE);
    expect(child.tick).toHaveBeenCalledTimes(2);
  });

  it('stops early on RUNNING', async () => {
    const child = dynamicChild([NodeStatus.SUCCESS, NodeStatus.RUNNING]);
    const node = new RepeatNode({ name: 'rep', child, count: 5 });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
    expect(child.tick).toHaveBeenCalledTimes(2);
  });
});
