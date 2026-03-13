import { describe, it, expect, vi } from 'vitest';
import { SelectorNode } from './selector.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext, SelectionStrategy } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';
import { ActionNode } from '../nodes/action.js';

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
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

  describe('order commitment', () => {
    it('calls strategy.order() once per execution cycle even with RUNNING child', async () => {
      let slowCalls = 0;
      const slow: BTreeNode = {
        id: 'slow', name: 'slow',
        tick: async () => {
          slowCalls++;
          return slowCalls >= 3 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
        },
        reset: () => {}, abort: () => {},
      };

      const orderSpy = vi.fn(async (children: BTreeNode[]) => children);
      const strategy: SelectionStrategy = { order: orderSpy };

      const node = new SelectorNode({
        name: 'sel',
        children: [actionNode('a', NodeStatus.FAILURE), slow],
        strategy,
      });
      const ctx = createContext();

      await node.tick(ctx); // RUNNING
      await node.tick(ctx); // RUNNING
      await node.tick(ctx); // SUCCESS

      expect(orderSpy).toHaveBeenCalledTimes(1);
    });

    it('re-consults strategy on a new execution cycle after SUCCESS', async () => {
      const orderSpy = vi.fn(async (children: BTreeNode[]) => children);
      const strategy: SelectionStrategy = { order: orderSpy };

      const node = new SelectorNode({
        name: 'sel',
        children: [actionNode('a', NodeStatus.SUCCESS)],
        strategy,
      });
      const ctx = createContext();

      await node.tick(ctx); // SUCCESS — cycle 1
      await node.tick(ctx); // SUCCESS — cycle 2

      expect(orderSpy).toHaveBeenCalledTimes(2);
    });

    it('re-consults strategy on a new execution cycle after FAILURE', async () => {
      const orderSpy = vi.fn(async (children: BTreeNode[]) => children);
      const strategy: SelectionStrategy = { order: orderSpy };

      const node = new SelectorNode({
        name: 'sel',
        children: [actionNode('a', NodeStatus.FAILURE)],
        strategy,
      });
      const ctx = createContext();

      await node.tick(ctx); // FAILURE — cycle 1
      await node.tick(ctx); // FAILURE — cycle 2

      expect(orderSpy).toHaveBeenCalledTimes(2);
    });

    it('re-consults strategy after reset()', async () => {
      const child: BTreeNode = {
        id: 'c', name: 'c',
        tick: async () => NodeStatus.RUNNING,
        reset: () => {}, abort: () => {},
      };

      const orderSpy = vi.fn(async (children: BTreeNode[]) => children);
      const strategy: SelectionStrategy = { order: orderSpy };

      const node = new SelectorNode({ name: 'sel', children: [child], strategy });
      const ctx = createContext();

      await node.tick(ctx); // RUNNING — commits order
      expect(orderSpy).toHaveBeenCalledTimes(1);

      node.reset();
      await node.tick(ctx); // RUNNING — new cycle after reset
      expect(orderSpy).toHaveBeenCalledTimes(2);
    });

    it('committed order is stable even if strategy would return different results', async () => {
      let callCount = 0;
      let bCalls = 0;
      const a: BTreeNode = {
        id: 'a', name: 'a',
        tick: async () => NodeStatus.FAILURE,
        reset: () => {}, abort: () => {},
      };
      const b: BTreeNode = {
        id: 'b', name: 'b',
        tick: async () => {
          bCalls++;
          return bCalls <= 2 ? NodeStatus.RUNNING : NodeStatus.SUCCESS;
        },
        reset: () => {}, abort: () => {},
      };

      const strategy: SelectionStrategy = {
        order: async (children) => {
          callCount++;
          // First call: [a, b], second call would be [b, a]
          return callCount === 1 ? [a, b] : [b, a];
        },
      };

      const node = new SelectorNode({ name: 'sel', children: [a, b], strategy });
      const ctx = createContext();

      // Tick 1: strategy returns [a, b]; a fails, b RUNNING
      expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
      // Tick 2: committed order still [a, b]; b still RUNNING
      expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
      // Tick 3: committed order still [a, b]; b succeeds
      expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);

      // Strategy was only called once for the entire cycle
      expect(callCount).toBe(1);
    });
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
