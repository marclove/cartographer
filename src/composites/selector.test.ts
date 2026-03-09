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

  it('resumes from RUNNING child on next tick', async () => {
    let retryCalls = 0;
    const tickCounts = { fast: 0, slow: 0, fallback: 0 };

    const fast: BTreeNode = {
      id: 'fast', name: 'fast',
      tick: async () => { tickCounts.fast++; return NodeStatus.FAILURE; },
      reset: () => {}, abort: () => {},
    };
    const slow: BTreeNode = {
      id: 'slow', name: 'slow',
      tick: async () => {
        tickCounts.slow++;
        retryCalls++;
        return retryCalls >= 3 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
      },
      reset: () => {}, abort: () => {},
    };
    const fallback: BTreeNode = {
      id: 'fallback', name: 'fallback',
      tick: async () => { tickCounts.fallback++; return NodeStatus.SUCCESS; },
      reset: () => {}, abort: () => {},
    };

    const node = new SelectorNode({ name: 'sel', children: [fast, slow, fallback] });
    const ctx = createContext();

    // Tick 1: fast fails, slow returns RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    // Tick 2: resumes at slow, still RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    // Tick 3: resumes at slow, succeeds
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);

    expect(tickCounts.fast).toBe(1);
    expect(tickCounts.slow).toBe(3);
    expect(tickCounts.fallback).toBe(0);
  });

  it('resets runningChildId on SUCCESS', async () => {
    let call = 0;
    const tickCounts = { a: 0, b: 0 };

    const a: BTreeNode = {
      id: 'a', name: 'a',
      tick: async () => { tickCounts.a++; return NodeStatus.FAILURE; },
      reset: () => {}, abort: () => {},
    };
    const b: BTreeNode = {
      id: 'b', name: 'b',
      tick: async () => {
        tickCounts.b++;
        call++;
        if (call === 1) return NodeStatus.RUNNING;
        if (call === 2) return NodeStatus.SUCCESS;
        return NodeStatus.FAILURE;
      },
      reset: () => {}, abort: () => {},
    };

    const node = new SelectorNode({ name: 'sel', children: [a, b] });
    const ctx = createContext();

    // Tick 1: a FAILURE, b RUNNING (saved)
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(tickCounts.a).toBe(1);

    // Tick 2: resumes at b, b SUCCESS → runningChildId cleared
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(tickCounts.a).toBe(1); // a was skipped

    // Tick 3: starts from child 0 again since runningChildId was cleared
    // a FAILURE, b FAILURE → selector FAILURE
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
    expect(tickCounts.a).toBe(2); // a ticked again
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
