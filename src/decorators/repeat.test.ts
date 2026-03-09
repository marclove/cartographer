import { describe, it, expect, vi } from 'vitest';
import { RepeatNode } from './repeat.js';
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
