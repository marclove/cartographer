import { describe, it, expect, vi } from 'vitest';
import { RetryNode } from './retry.js';
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
