import { describe, it, expect, vi } from 'vitest';
import { SequenceNode } from './sequence.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext, ExecutionStrategy } from '../types.js';
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

  it('resumes from RUNNING child on next tick', async () => {
    let healthCheckCalls = 0;
    const tickCounts = { deploy: 0, health: 0, notify: 0 };

    const deploy: BTreeNode = {
      id: 'deploy', name: 'deploy',
      tick: async () => { tickCounts.deploy++; return NodeStatus.SUCCESS; },
      reset: () => {}, abort: () => {},
    };
    const health: BTreeNode = {
      id: 'health', name: 'health',
      tick: async () => {
        tickCounts.health++;
        healthCheckCalls++;
        return healthCheckCalls >= 3 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
      },
      reset: () => {}, abort: () => {},
    };
    const notify: BTreeNode = {
      id: 'notify', name: 'notify',
      tick: async () => { tickCounts.notify++; return NodeStatus.SUCCESS; },
      reset: () => {}, abort: () => {},
    };

    const node = new SequenceNode({ name: 'seq', children: [deploy, health, notify] });
    const ctx = createContext();

    // Tick 1: deploy succeeds, health returns RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    // Tick 2: resumes at health, still RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    // Tick 3: resumes at health, succeeds, notify succeeds
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);

    expect(tickCounts.deploy).toBe(1);
    expect(tickCounts.health).toBe(3);
    expect(tickCounts.notify).toBe(1);
  });

  it('resets runningChildId on FAILURE', async () => {
    let call = 0;
    const tickCounts = { a: 0, b: 0 };

    const a: BTreeNode = {
      id: 'a', name: 'a',
      tick: async () => { tickCounts.a++; return NodeStatus.SUCCESS; },
      reset: () => {}, abort: () => {},
    };
    const b: BTreeNode = {
      id: 'b', name: 'b',
      tick: async () => {
        tickCounts.b++;
        call++;
        if (call === 1) return NodeStatus.RUNNING;
        return NodeStatus.FAILURE;
      },
      reset: () => {}, abort: () => {},
    };

    const node = new SequenceNode({ name: 'seq', children: [a, b] });
    const ctx = createContext();

    // Tick 1: a SUCCESS, b RUNNING (saved)
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(tickCounts.a).toBe(1);

    // Tick 2: resumes at b, b FAILURE → runningChildId cleared
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
    expect(tickCounts.a).toBe(1); // a was skipped

    // Tick 3: starts from child 0 again since runningChildId was cleared
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
    expect(tickCounts.a).toBe(2); // a ticked again
  });

  it('reset() clears running child state', async () => {
    const tickCounts = { a: 0, b: 0 };
    const a: BTreeNode = {
      id: 'a', name: 'a',
      tick: async () => { tickCounts.a++; return NodeStatus.SUCCESS; },
      reset: () => {}, abort: () => {},
    };
    const b: BTreeNode = {
      id: 'b', name: 'b',
      tick: async () => { tickCounts.b++; return NodeStatus.RUNNING; },
      reset: () => {}, abort: () => {},
    };

    const node = new SequenceNode({ name: 'seq', children: [a, b] });
    const ctx = createContext();

    await node.tick(ctx); // a=SUCCESS, b=RUNNING
    expect(tickCounts.a).toBe(1);

    node.reset();
    await node.tick(ctx); // should start from a again
    expect(tickCounts.a).toBe(2);
  });

  describe('order commitment', () => {
    it('calls strategy.order() once per execution cycle even with RUNNING child', async () => {
      let healthCalls = 0;
      const health: BTreeNode = {
        id: 'health', name: 'health',
        tick: async () => {
          healthCalls++;
          return healthCalls >= 3 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
        },
        reset: () => {}, abort: () => {},
      };

      const orderSpy = vi.fn(async (children: BTreeNode[]) => children);
      const strategy: ExecutionStrategy = { order: orderSpy };

      const node = new SequenceNode({
        name: 'seq',
        children: [actionNode('a', NodeStatus.SUCCESS), health],
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
      const strategy: ExecutionStrategy = { order: orderSpy };

      const node = new SequenceNode({
        name: 'seq',
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
      const strategy: ExecutionStrategy = { order: orderSpy };

      const node = new SequenceNode({
        name: 'seq',
        children: [actionNode('a', NodeStatus.FAILURE)],
        strategy,
      });
      const ctx = createContext();

      await node.tick(ctx); // FAILURE — cycle 1
      await node.tick(ctx); // FAILURE — cycle 2

      expect(orderSpy).toHaveBeenCalledTimes(2);
    });

    it('re-consults strategy after reset()', async () => {
      let calls = 0;
      const child: BTreeNode = {
        id: 'c', name: 'c',
        tick: async () => {
          calls++;
          return NodeStatus.RUNNING;
        },
        reset: () => {}, abort: () => {},
      };

      const orderSpy = vi.fn(async (children: BTreeNode[]) => children);
      const strategy: ExecutionStrategy = { order: orderSpy };

      const node = new SequenceNode({ name: 'seq', children: [child], strategy });
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
        tick: async () => NodeStatus.SUCCESS,
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

      const strategy: ExecutionStrategy = {
        order: async (children) => {
          callCount++;
          // First call: [a, b], second call would be [b, a]
          return callCount === 1 ? [a, b] : [b, a];
        },
      };

      const node = new SequenceNode({ name: 'seq', children: [a, b], strategy });
      const ctx = createContext();

      // Tick 1: strategy returns [a, b]; a succeeds, b RUNNING
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
