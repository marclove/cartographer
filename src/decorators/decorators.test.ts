import { describe, it, expect, vi } from 'vitest';
import { InverterNode } from './inverter.js';
import { RepeatNode } from './repeat.js';
import { RetryNode } from './retry.js';
import { AlwaysSucceedNode } from './always-succeed.js';
import { AlwaysFailNode } from './always-fail.js';
import { TimeoutNode } from './timeout.js';
import { GuardNode } from './guard.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { MapBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';

function createContext(): TreeContext {
  return {
    blackboard: new MapBlackboard(),
    events: new EventEmitter<TreeEvents>(),
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

describe('InverterNode', () => {
  it('flips SUCCESS to FAILURE', async () => {
    const node = new InverterNode({ name: 'inv', child: mockChild(NodeStatus.SUCCESS) });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('flips FAILURE to SUCCESS', async () => {
    const node = new InverterNode({ name: 'inv', child: mockChild(NodeStatus.FAILURE) });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('passes RUNNING through unchanged', async () => {
    const node = new InverterNode({ name: 'inv', child: mockChild(NodeStatus.RUNNING) });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });

  it('delegates reset to child', () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new InverterNode({ name: 'inv', child });
    node.reset();
    expect(child.reset).toHaveBeenCalled();
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

describe('RetryNode', () => {
  it('returns SUCCESS on first try if child succeeds', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new RetryNode({ name: 'retry', child, maxAttempts: 3 });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(1);
  });

  it('retries on FAILURE up to maxAttempts', async () => {
    const child = mockChild(NodeStatus.FAILURE);
    const node = new RetryNode({ name: 'retry', child, maxAttempts: 3 });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
    expect(child.tick).toHaveBeenCalledTimes(3);
  });

  it('succeeds if a retry succeeds', async () => {
    const child = dynamicChild([NodeStatus.FAILURE, NodeStatus.FAILURE, NodeStatus.SUCCESS]);
    const node = new RetryNode({ name: 'retry', child, maxAttempts: 5 });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(3);
  });

  it('returns RUNNING immediately without retry', async () => {
    const child = mockChild(NodeStatus.RUNNING);
    const node = new RetryNode({ name: 'retry', child, maxAttempts: 3 });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
    expect(child.tick).toHaveBeenCalledTimes(1);
  });

  it('delays between retries when delayMs is set', async () => {
    const child = dynamicChild([NodeStatus.FAILURE, NodeStatus.SUCCESS]);
    const node = new RetryNode({ name: 'retry', child, maxAttempts: 3, delayMs: 50 });
    const start = performance.now();
    await node.tick(createContext());
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

describe('AlwaysSucceedNode', () => {
  it('returns SUCCESS when child succeeds', async () => {
    const node = new AlwaysSucceedNode({ name: 'as', child: mockChild(NodeStatus.SUCCESS) });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns SUCCESS when child fails', async () => {
    const node = new AlwaysSucceedNode({ name: 'as', child: mockChild(NodeStatus.FAILURE) });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns RUNNING when child returns RUNNING', async () => {
    const node = new AlwaysSucceedNode({ name: 'as', child: mockChild(NodeStatus.RUNNING) });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });
});

describe('AlwaysFailNode', () => {
  it('returns FAILURE when child succeeds', async () => {
    const node = new AlwaysFailNode({ name: 'af', child: mockChild(NodeStatus.SUCCESS) });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('returns FAILURE when child fails', async () => {
    const node = new AlwaysFailNode({ name: 'af', child: mockChild(NodeStatus.FAILURE) });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('returns RUNNING when child returns RUNNING', async () => {
    const node = new AlwaysFailNode({ name: 'af', child: mockChild(NodeStatus.RUNNING) });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });
});

describe('TimeoutNode', () => {
  it('returns child status when child completes within timeout', async () => {
    const node = new TimeoutNode({
      name: 'to',
      child: mockChild(NodeStatus.SUCCESS),
      timeoutMs: 1000,
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns FAILURE when child exceeds timeout', async () => {
    const slowChild: BTreeNode = {
      id: 'slow', name: 'slow',
      tick: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return NodeStatus.SUCCESS;
      },
      reset: () => {}, abort: vi.fn(),
    };
    const node = new TimeoutNode({ name: 'to', child: slowChild, timeoutMs: 50 });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });
});

describe('GuardNode', () => {
  it('ticks child when condition is true', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new GuardNode({ name: 'guard', child, condition: () => true });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalled();
  });

  it('returns FAILURE without ticking child when condition is false', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new GuardNode({ name: 'guard', child, condition: () => false });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
    expect(child.tick).not.toHaveBeenCalled();
  });

  it('supports async conditions', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new GuardNode({ name: 'guard', child, condition: async () => true });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns FAILURE when condition throws', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new GuardNode({
      name: 'guard', child,
      condition: () => { throw new Error('boom'); },
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
    expect(child.tick).not.toHaveBeenCalled();
  });
});
