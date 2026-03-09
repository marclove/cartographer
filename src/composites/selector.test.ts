import { describe, it, expect, vi } from 'vitest';
import { SelectorNode } from './selector.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext, SelectionStrategy } from '../types.js';
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

describe('SelectorNode', () => {
  it('returns SUCCESS when first child succeeds', async () => {
    const node = new SelectorNode({
      name: 'sel',
      children: [actionNode('a', NodeStatus.SUCCESS), actionNode('b', NodeStatus.FAILURE)],
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns SUCCESS when second child succeeds after first fails', async () => {
    const node = new SelectorNode({
      name: 'sel',
      children: [actionNode('a', NodeStatus.FAILURE), actionNode('b', NodeStatus.SUCCESS)],
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns FAILURE when all children fail', async () => {
    const node = new SelectorNode({
      name: 'sel',
      children: [actionNode('a', NodeStatus.FAILURE), actionNode('b', NodeStatus.FAILURE)],
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('returns RUNNING when a child returns RUNNING', async () => {
    const node = new SelectorNode({
      name: 'sel',
      children: [actionNode('a', NodeStatus.FAILURE), actionNode('b', NodeStatus.RUNNING)],
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });

  it('does not tick children after SUCCESS', async () => {
    const tickSpy = vi.fn(async () => NodeStatus.FAILURE);
    const secondChild: BTreeNode = {
      id: '2', name: 'b', tick: tickSpy, reset: () => {}, abort: () => {},
    };
    const node = new SelectorNode({
      name: 'sel',
      children: [actionNode('a', NodeStatus.SUCCESS), secondChild],
    });
    await node.tick(createContext());
    expect(tickSpy).not.toHaveBeenCalled();
  });

  it('uses a custom strategy to reorder children', async () => {
    const reverseStrategy: SelectionStrategy = {
      order: async (children) => [...children].reverse(),
    };
    const order: string[] = [];
    const trackingNode = (name: string, status: NodeStatus): BTreeNode => ({
      id: name, name,
      tick: async () => { order.push(name); return status; },
      reset: () => {}, abort: () => {},
    });
    const node = new SelectorNode({
      name: 'sel',
      children: [trackingNode('a', NodeStatus.FAILURE), trackingNode('b', NodeStatus.FAILURE)],
      strategy: reverseStrategy,
    });
    await node.tick(createContext());
    expect(order).toEqual(['b', 'a']);
  });

  it('resets all children on reset()', () => {
    const resetSpy1 = vi.fn();
    const resetSpy2 = vi.fn();
    const child1: BTreeNode = { id: '1', name: 'a', tick: async () => NodeStatus.SUCCESS, reset: resetSpy1, abort: () => {} };
    const child2: BTreeNode = { id: '2', name: 'b', tick: async () => NodeStatus.SUCCESS, reset: resetSpy2, abort: () => {} };
    const node = new SelectorNode({ name: 'sel', children: [child1, child2] });
    node.reset();
    expect(resetSpy1).toHaveBeenCalled();
    expect(resetSpy2).toHaveBeenCalled();
  });
});
