import { describe, it, expect, vi } from 'vitest';
import { SequenceNode } from './sequence.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext, ExecutionStrategy } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { MapBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';
import { ActionNode } from '../nodes/action.js';

function createContext(): TreeContext {
  return {
    blackboard: new MapBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

function actionNode(name: string, status: NodeStatus): ActionNode {
  return new ActionNode({ name, action: () => status });
}

describe('SequenceNode', () => {
  it('returns SUCCESS when all children succeed', async () => {
    const node = new SequenceNode({
      name: 'seq',
      children: [actionNode('a', NodeStatus.SUCCESS), actionNode('b', NodeStatus.SUCCESS)],
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns FAILURE when first child fails', async () => {
    const node = new SequenceNode({
      name: 'seq',
      children: [actionNode('a', NodeStatus.FAILURE), actionNode('b', NodeStatus.SUCCESS)],
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('returns FAILURE when second child fails', async () => {
    const node = new SequenceNode({
      name: 'seq',
      children: [actionNode('a', NodeStatus.SUCCESS), actionNode('b', NodeStatus.FAILURE)],
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('returns RUNNING when a child returns RUNNING', async () => {
    const node = new SequenceNode({
      name: 'seq',
      children: [actionNode('a', NodeStatus.SUCCESS), actionNode('b', NodeStatus.RUNNING)],
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });

  it('does not tick children after FAILURE', async () => {
    const tickSpy = vi.fn(async () => NodeStatus.SUCCESS);
    const secondChild: BTreeNode = {
      id: '2', name: 'b', tick: tickSpy, reset: () => {}, abort: () => {},
    };
    const node = new SequenceNode({
      name: 'seq',
      children: [actionNode('a', NodeStatus.FAILURE), secondChild],
    });
    await node.tick(createContext());
    expect(tickSpy).not.toHaveBeenCalled();
  });

  it('uses a custom strategy to reorder children', async () => {
    const reverseStrategy: ExecutionStrategy = {
      order: async (children) => [...children].reverse(),
    };
    const order: string[] = [];
    const trackingNode = (name: string): BTreeNode => ({
      id: name, name,
      tick: async () => { order.push(name); return NodeStatus.SUCCESS; },
      reset: () => {}, abort: () => {},
    });
    const node = new SequenceNode({
      name: 'seq',
      children: [trackingNode('a'), trackingNode('b')],
      strategy: reverseStrategy,
    });
    await node.tick(createContext());
    expect(order).toEqual(['b', 'a']);
  });
});
