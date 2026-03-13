import { describe, it, expect, vi } from 'vitest';
import { SelectorNode } from './selector.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext, SelectionStrategy } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';

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

describe('SelectorNode (reactive)', () => {
  function createContext(overrides?: Partial<TreeContext>): TreeContext {
    return {
      blackboard: new InMemoryBlackboard(),
      events: new EventEmitter<TreeEvents>(),
      ...overrides,
    };
  }

  function createDeferredAction() {
    let resolve: (status: NodeStatus) => void;
    const action = new ActionNode({
      name: 'deferred',
      action: async () => new Promise<NodeStatus>(r => { resolve = r; }),
    });
    return { action, resolve: (s: NodeStatus) => resolve(s) };
  }

  const flush = () => new Promise(r => setTimeout(r, 0));

  it('re-evaluates conditions every tick', async () => {
    const ctx = createContext();
    ctx.blackboard.set('flag', false);

    const cond = new ConditionNode({
      name: 'cond',
      condition: (c) => c.blackboard.get<boolean>('flag') === true,
    });

    const { action, resolve } = createDeferredAction();

    const sel = new SelectorNode({
      name: 'sel',
      children: [cond, action],
    });

    // Tick 1: cond FAILURE, action starts → RUNNING
    expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();

    // Tick 2: cond still FAILURE (flag=false), action still RUNNING
    expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);

    // Change blackboard so condition succeeds
    ctx.blackboard.set('flag', true);

    // Tick 3: cond SUCCESS → action aborted, selector returns SUCCESS
    expect(await sel.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('higher-priority preemption aborts lower-priority RUNNING child', async () => {
    const ctx = createContext();
    ctx.blackboard.set('ready', false);

    const cond = new ConditionNode({
      name: 'cond',
      condition: (c) => c.blackboard.get<boolean>('ready') === true,
    });

    const abortSpy = vi.fn();
    const { action } = createDeferredAction();
    const originalAbort = action.abort.bind(action);
    action.abort = () => { abortSpy(); originalAbort(); };

    const sel = new SelectorNode({
      name: 'sel',
      children: [cond, action],
    });

    // Tick 1: cond FAILURE, action starts → RUNNING
    expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();

    // Higher-priority branch now succeeds
    ctx.blackboard.set('ready', true);

    // Tick 2: cond SUCCESS → action aborted, returns SUCCESS
    expect(await sel.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(abortSpy).toHaveBeenCalled();
  });

  it('caches completed non-reactive children within a cycle', async () => {
    const ctx = createContext();
    let action1TickCount = 0;

    const action1 = new ActionNode({
      name: 'action1',
      action: async () => {
        action1TickCount++;
        return NodeStatus.FAILURE;
      },
    });

    const { action: action2 } = createDeferredAction();

    const sel = new SelectorNode({
      name: 'sel',
      children: [action1, action2],
    });

    // Tick 1: action1 starts (inflight) → RUNNING
    expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();

    // Tick 2: action1 returns FAILURE (from inflight), action2 starts → RUNNING
    expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();

    // action1 was ticked once to start, once to get result = 2 ticks total
    expect(action1TickCount).toBe(1);

    // Tick 3: action1 FAILURE is cached (not re-ticked), action2 still RUNNING
    expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);

    // action1 was NOT re-ticked — still 1 action call (2 tick() calls but
    // the second returned the cached inflight result, third used completedMap)
    expect(action1TickCount).toBe(1);
  });

  it('clears cycle cache on cycle end (terminal status)', async () => {
    const ctx = createContext();
    let actionCallCount = 0;

    const action = new ActionNode({
      name: 'action',
      action: async () => {
        actionCallCount++;
        return NodeStatus.SUCCESS;
      },
    });

    const sel = new SelectorNode({
      name: 'sel',
      children: [action],
    });

    // Tick 1: action starts (inflight) → RUNNING
    expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();

    // Tick 2: action returns SUCCESS → cycle ends, cache cleared
    expect(await sel.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(actionCallCount).toBe(1);

    // Tick 3: new cycle — action should be re-executed (fresh, not cached)
    expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();

    // Tick 4: action returns SUCCESS again
    expect(await sel.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(actionCallCount).toBe(2);
  });

  it('abort() clears all state and aborts child controllers', async () => {
    const ctx = createContext();

    const { action } = createDeferredAction();
    const abortSpy = vi.fn();
    const originalAbort = action.abort.bind(action);
    action.abort = () => { abortSpy(); originalAbort(); };

    const cond = new ConditionNode({
      name: 'cond',
      condition: () => false,
    });

    const sel = new SelectorNode({
      name: 'sel',
      children: [cond, action],
    });

    // Tick 1: cond FAILURE, action starts → RUNNING
    expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();

    // Abort the selector
    sel.abort();
    expect(abortSpy).toHaveBeenCalled();

    // Next tick starts a fresh cycle (no cached state)
    expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
  });

  it('reset() clears all state and cascades to children', async () => {
    const ctx = createContext();

    const resetSpy = vi.fn();
    const { action } = createDeferredAction();
    const originalReset = action.reset.bind(action);
    action.reset = () => { resetSpy(); originalReset(); };

    const cond = new ConditionNode({
      name: 'cond',
      condition: () => false,
    });

    const sel = new SelectorNode({
      name: 'sel',
      children: [cond, action],
    });

    // Tick 1: cond FAILURE, action starts → RUNNING
    expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();

    // Reset the selector
    sel.reset();
    expect(resetSpy).toHaveBeenCalled();

    // Next tick starts a fresh cycle
    expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
  });

  it('scoped AbortController receives parent signal abort', async () => {
    const parentController = new AbortController();
    const ctx = createContext({ signal: parentController.signal });

    const { action } = createDeferredAction();

    const sel = new SelectorNode({
      name: 'sel',
      children: [action],
    });

    // Tick 1: action starts → RUNNING, scoped controller created
    expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();

    // Parent abort cascades to child controller
    parentController.abort();

    // Tick 2: the scoped signal should be aborted
    // The action still returns RUNNING (inflight poll), but the signal is aborted
    expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
  });

  it('does not re-tick RUNNING child from scratch (polls inflight)', async () => {
    const ctx = createContext();
    let actionStartCount = 0;

    const action = new ActionNode({
      name: 'slow',
      action: async () => {
        actionStartCount++;
        return new Promise<NodeStatus>((resolve) => {
          setTimeout(() => resolve(NodeStatus.SUCCESS), 50);
        });
      },
    });

    const sel = new SelectorNode({
      name: 'sel',
      children: [action],
    });

    // Tick 1: action starts → RUNNING
    expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);

    // Tick 2: action is still RUNNING (polled, not restarted)
    expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);

    // The action function was only called once (start), not on subsequent polls
    expect(actionStartCount).toBe(1);

    // Wait for action to complete
    await new Promise(r => setTimeout(r, 60));

    // Tick 3: action returns SUCCESS
    expect(await sel.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(actionStartCount).toBe(1);
  });
});
