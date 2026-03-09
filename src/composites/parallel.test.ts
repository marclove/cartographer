import { describe, it, expect } from 'vitest';
import { ParallelNode } from './parallel.js';
import { NodeStatus } from '../types.js';
import type { TreeContext, ParallelStrategy, ParallelPolicy, BTreeNode } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { MapBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';

function createContext(): TreeContext {
  return {
    blackboard: new MapBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

function actionNode(name: string, status: NodeStatus): ActionNode {
  return new ActionNode({ name, action: () => status });
}

describe('ParallelNode', () => {
  it('returns SUCCESS when all children succeed (default policy)', async () => {
    const node = new ParallelNode({
      name: 'par',
      children: [actionNode('a', NodeStatus.SUCCESS), actionNode('b', NodeStatus.SUCCESS)],
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns FAILURE when any child fails (default policy requires all)', async () => {
    const node = new ParallelNode({
      name: 'par',
      children: [actionNode('a', NodeStatus.SUCCESS), actionNode('b', NodeStatus.FAILURE)],
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('returns SUCCESS when successCount threshold is met', async () => {
    const node = new ParallelNode({
      name: 'par',
      children: [
        actionNode('a', NodeStatus.SUCCESS),
        actionNode('b', NodeStatus.FAILURE),
        actionNode('c', NodeStatus.SUCCESS),
      ],
      strategy: new DefaultParallelStrategy({ successCount: 2 }),
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns FAILURE when failureCount threshold is met', async () => {
    const node = new ParallelNode({
      name: 'par',
      children: [
        actionNode('a', NodeStatus.FAILURE),
        actionNode('b', NodeStatus.FAILURE),
        actionNode('c', NodeStatus.SUCCESS),
      ],
      strategy: new DefaultParallelStrategy({ failureCount: 2 }),
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('returns SUCCESS when successPercentage threshold is met', async () => {
    const node = new ParallelNode({
      name: 'par',
      children: [
        actionNode('a', NodeStatus.SUCCESS),
        actionNode('b', NodeStatus.FAILURE),
        actionNode('c', NodeStatus.SUCCESS),
        actionNode('d', NodeStatus.SUCCESS),
      ],
      strategy: new DefaultParallelStrategy({ successPercentage: 50 }),
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns RUNNING when any child returns RUNNING', async () => {
    const node = new ParallelNode({
      name: 'par',
      children: [actionNode('a', NodeStatus.SUCCESS), actionNode('b', NodeStatus.RUNNING)],
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });

  it('ticks all children concurrently', async () => {
    const order: string[] = [];
    const delayNode = (name: string, ms: number): BTreeNode => ({
      id: name, name,
      tick: async () => {
        await new Promise((r) => setTimeout(r, ms));
        order.push(name);
        return NodeStatus.SUCCESS;
      },
      reset: () => {}, abort: () => {},
    });
    const node = new ParallelNode({
      name: 'par',
      children: [delayNode('slow', 20), delayNode('fast', 5)],
    });
    await node.tick(createContext());
    expect(order).toEqual(['fast', 'slow']);
  });

  it('uses a custom strategy for policy', async () => {
    const customStrategy: ParallelStrategy = {
      policy: async () => ({ successCount: 1 }),
    };
    const node = new ParallelNode({
      name: 'par',
      children: [actionNode('a', NodeStatus.SUCCESS), actionNode('b', NodeStatus.FAILURE)],
      strategy: customStrategy,
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });
});
