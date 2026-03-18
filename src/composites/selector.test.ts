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

const flush = () => new Promise(r => setTimeout(r, 0));

function actionNode(name: string, status: NodeStatus): ActionNode {
  return new ActionNode({ name, action: () => status });
}

describe('SelectorNode', () => {
  it('returns SUCCESS when first child succeeds', async () => {
    const node = new SelectorNode({
      name: 'sel',
      children: [actionNode('a', NodeStatus.SUCCESS), actionNode('b', NodeStatus.FAILURE)],
    });
    const ctx = createContext();
    // Tick 1: a starts inflight → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    // Tick 2: a completes SUCCESS → selector SUCCESS
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('returns SUCCESS when second child succeeds after first fails', async () => {
    const node = new SelectorNode({
      name: 'sel',
      children: [actionNode('a', NodeStatus.FAILURE), actionNode('b', NodeStatus.SUCCESS)],
    });
    const ctx = createContext();
    // Tick 1: a starts inflight → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    // Tick 2: a completes FAILURE (cached), b starts inflight → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    // Tick 3: a cached FAILURE, b completes SUCCESS → selector SUCCESS
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('returns FAILURE when all children fail', async () => {
    const node = new SelectorNode({
      name: 'sel',
      children: [actionNode('a', NodeStatus.FAILURE), actionNode('b', NodeStatus.FAILURE)],
    });
    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
  });

  it('returns RUNNING when a child returns RUNNING', async () => {
    const node = new SelectorNode({
      name: 'sel',
      children: [actionNode('a', NodeStatus.FAILURE), actionNode('b', NodeStatus.RUNNING)],
    });
    const ctx = createContext();
    // Tick 1: a starts inflight → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    // Tick 2: a completes FAILURE (cached), b starts inflight → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    // Tick 3: a cached FAILURE, b returns RUNNING from inflight (action returns RUNNING) → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
  });

  it('resumes from RUNNING child on next tick', async () => {
    let retryCalls = 0;
    const tickCounts = { fast: 0, slow: 0, fallback: 0 };

    const fast: BTreeNode = {
      id: 'fast', name: 'fast', children: [],
      tick: async () => { tickCounts.fast++; return NodeStatus.FAILURE; },
      reset: () => {}, abort: () => {},
    };
    const slow: BTreeNode = {
      id: 'slow', name: 'slow', children: [],
      tick: async () => {
        tickCounts.slow++;
        retryCalls++;
        return retryCalls >= 3 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
      },
      reset: () => {}, abort: () => {},
    };
    const fallback: BTreeNode = {
      id: 'fallback', name: 'fallback', children: [],
      tick: async () => { tickCounts.fallback++; return NodeStatus.SUCCESS; },
      reset: () => {}, abort: () => {},
    };

    const node = new SelectorNode({ name: 'sel', children: [fast, slow, fallback] });
    const ctx = createContext();

    // Tick 1: fast FAILURE (cached), slow RUNNING → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    // Tick 2: fast cached, slow still RUNNING → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    // Tick 3: fast cached, slow SUCCESS → selector SUCCESS
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);

    // fast was ticked once then cached
    expect(tickCounts.fast).toBe(1);
    expect(tickCounts.slow).toBe(3);
    expect(tickCounts.fallback).toBe(0);
  });

  it('clears cycle on SUCCESS and re-evaluates from start', async () => {
    let call = 0;
    const tickCounts = { a: 0, b: 0 };

    const a: BTreeNode = {
      id: 'a', name: 'a', children: [],
      tick: async () => { tickCounts.a++; return NodeStatus.FAILURE; },
      reset: () => {}, abort: () => {},
    };
    const b: BTreeNode = {
      id: 'b', name: 'b', children: [],
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

    // Tick 1: a FAILURE (cached), b RUNNING → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(tickCounts.a).toBe(1);

    // Tick 2: a cached (FAILURE), b SUCCESS → cycle cleared, SUCCESS
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(tickCounts.a).toBe(1); // a was cached

    // Tick 3: new cycle — a ticked again (cache cleared), b FAILURE → FAILURE
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
    expect(tickCounts.a).toBe(2);
  });

  it('does not tick children after SUCCESS', async () => {
    const tickSpy = vi.fn(async () => NodeStatus.FAILURE);
    const secondChild: BTreeNode = {
      id: '2', name: 'b', children: [], tick: tickSpy, reset: () => {}, abort: () => {},
    };
    const node = new SelectorNode({
      name: 'sel',
      children: [actionNode('a', NodeStatus.SUCCESS), secondChild],
    });
    const ctx = createContext();
    // Tick 1: a starts inflight → RUNNING (b not ticked yet)
    await node.tick(ctx);
    expect(tickSpy).not.toHaveBeenCalled();
    await flush();
    // Tick 2: a completes SUCCESS → b still not ticked
    await node.tick(ctx);
    expect(tickSpy).not.toHaveBeenCalled();
  });

  describe('order commitment', () => {
    it('calls strategy.order() once per execution cycle even with RUNNING child', async () => {
      let slowCalls = 0;
      const slow: BTreeNode = {
        id: 'slow', name: 'slow', children: [],
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

      // Tick 1: action 'a' starts inflight → RUNNING
      await node.tick(ctx);
      await flush();
      // Tick 2: a FAILURE (cached), slow RUNNING → RUNNING
      await node.tick(ctx);
      // Tick 3: a cached, slow RUNNING → RUNNING
      await node.tick(ctx);
      // Tick 4: a cached, slow SUCCESS → cycle ends
      await node.tick(ctx);

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

      // Cycle 1
      await node.tick(ctx);
      await flush();
      await node.tick(ctx);

      // Cycle 2
      await node.tick(ctx);
      await flush();
      await node.tick(ctx);

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

      // Cycle 1
      await node.tick(ctx);
      await flush();
      await node.tick(ctx);

      // Cycle 2
      await node.tick(ctx);
      await flush();
      await node.tick(ctx);

      expect(orderSpy).toHaveBeenCalledTimes(2);
    });

    it('re-consults strategy after reset()', async () => {
      const child: BTreeNode = {
        id: 'c', name: 'c', children: [],
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
        id: 'a', name: 'a', children: [],
        tick: async () => NodeStatus.FAILURE,
        reset: () => {}, abort: () => {},
      };
      const b: BTreeNode = {
        id: 'b', name: 'b', children: [],
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
      id: name, name, children: [],
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
    const child1: BTreeNode = { id: '1', name: 'a', children: [], tick: async () => NodeStatus.SUCCESS, reset: resetSpy1, abort: () => {} };
    const child2: BTreeNode = { id: '2', name: 'b', children: [], tick: async () => NodeStatus.SUCCESS, reset: resetSpy2, abort: () => {} };
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
    let resolveAction: (status: NodeStatus) => void;

    const action = new ActionNode({
      name: 'slow',
      action: async () => {
        actionStartCount++;
        return new Promise<NodeStatus>(r => { resolveAction = r; });
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

    // Resolve the deferred action and flush the microtask
    resolveAction!(NodeStatus.SUCCESS);
    await flush();

    // Tick 3: action returns SUCCESS
    expect(await sel.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(actionStartCount).toBe(1);
  });
});

describe('SelectorNode serialize/restore', () => {
  function createCtx(): TreeContext {
    return {
      blackboard: new InMemoryBlackboard(),
      events: new EventEmitter<TreeEvents>(),
    };
  }

  /** Helper: create a mock BTreeNode with a stable contentHash and spied tick. */
  function mockNode(
    name: string,
    hash: string,
    tickFn: () => Promise<NodeStatus>,
  ): BTreeNode {
    return {
      id: name,
      name,
      children: [],
      tick: vi.fn(tickFn),
      reset: vi.fn(),
      abort: vi.fn(),
      interrupt: vi.fn(),
      hasInflightWork: () => false,
      inflightPromise: () => null,
      contentHash: () => hash,
      serialize: () => ({}),
      restore: () => {},
    };
  }

  it('serialize() returns committedOrder and completedMap after a partial tick', async () => {
    let bCalls = 0;
    const a = mockNode('a', 'hash-a', async () => NodeStatus.FAILURE);
    const b = mockNode('b', 'hash-b', async () => {
      bCalls++;
      return bCalls >= 3 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
    });

    const sel = new SelectorNode({ name: 'sel', children: [a, b] });
    const ctx = createCtx();

    // Tick 1: a FAILURE (cached), b RUNNING
    await sel.tick(ctx);

    const state = sel.serialize();
    // committedOrder should contain content hashes of both children
    expect(state.committedOrder).toEqual(['hash-a', 'hash-b']);
    // completedMap should have a's FAILURE cached
    expect(state.completedMap).toEqual({ 'hash-a': NodeStatus.FAILURE });
  });

  it('restore() rebuilds state and subsequent tick resumes correctly', async () => {
    let bCalls = 0;
    const a = mockNode('a', 'hash-a', async () => NodeStatus.FAILURE);
    const b = mockNode('b', 'hash-b', async () => {
      bCalls++;
      return bCalls >= 2 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
    });

    // Create a fresh selector (no prior ticks)
    const sel = new SelectorNode({ name: 'sel', children: [a, b] });
    const ctx = createCtx();

    // Build the hashToNode map that restore() needs
    const hashToNode = new Map<string, BTreeNode>([
      ['hash-a', a],
      ['hash-b', b],
    ]);

    // Restore state as if a previous run had a committed with [a, b] and a completed with FAILURE
    sel.restore(
      {
        committedOrder: ['hash-a', 'hash-b'],
        completedMap: { 'hash-a': NodeStatus.FAILURE },
      },
      hashToNode,
    );

    // Tick 1: a should use cached FAILURE (not re-ticked), b is RUNNING
    const status1 = await sel.tick(ctx);
    expect(status1).toBe(NodeStatus.RUNNING);
    // a.tick should NOT have been called because it's in completedMap
    expect(a.tick).not.toHaveBeenCalled();

    // Tick 2: a cached, b SUCCESS
    const status2 = await sel.tick(ctx);
    expect(status2).toBe(NodeStatus.SUCCESS);
  });

  it('restore() silently skips unknown hashes (partial restore)', async () => {
    const a = mockNode('a', 'hash-a', async () => NodeStatus.FAILURE);

    const sel = new SelectorNode({ name: 'sel', children: [a] });

    const hashToNode = new Map<string, BTreeNode>([['hash-a', a]]);

    // Restore with an unknown hash in committedOrder and completedMap
    sel.restore(
      {
        committedOrder: ['hash-a', 'hash-unknown'],
        completedMap: { 'hash-a': NodeStatus.FAILURE, 'hash-gone': NodeStatus.SUCCESS },
      },
      hashToNode,
    );

    // Should not throw, and the unknown entries are simply dropped
    const state = sel.serialize();
    // committedOrder should only contain the known hash
    expect(state.committedOrder).toEqual(['hash-a']);
    // completedMap should only contain the known hash
    expect(state.completedMap).toEqual({ 'hash-a': NodeStatus.FAILURE });
  });

  it('serialize() returns empty object when no cycle is active', () => {
    const a = mockNode('a', 'hash-a', async () => NodeStatus.SUCCESS);
    const sel = new SelectorNode({ name: 'sel', children: [a] });

    const state = sel.serialize();
    expect(state).toEqual({});
  });
});

describe('SelectorNode edge cases', () => {
  function createCtx(): TreeContext {
    return {
      blackboard: new InMemoryBlackboard(),
      events: new EventEmitter<TreeEvents>(),
    };
  }

  it('empty children array returns FAILURE immediately', async () => {
    const sel = new SelectorNode({ name: 'sel', children: [] });
    const ctx = createCtx();
    const status = await sel.tick(ctx);
    expect(status).toBe(NodeStatus.FAILURE);
  });

  it('abort() propagates to all children and clears internal state', async () => {
    const abortSpy1 = vi.fn();
    const abortSpy2 = vi.fn();

    const child1: BTreeNode = {
      id: 'c1', name: 'c1', children: [],
      tick: async () => NodeStatus.FAILURE,
      reset: vi.fn(), abort: abortSpy1,
      interrupt: vi.fn(),
      hasInflightWork: () => false,
      inflightPromise: () => null,
      contentHash: () => 'h1',
      serialize: () => ({}),
      restore: () => {},
    };
    const child2: BTreeNode = {
      id: 'c2', name: 'c2', children: [],
      tick: async () => NodeStatus.RUNNING,
      reset: vi.fn(), abort: abortSpy2,
      interrupt: vi.fn(),
      hasInflightWork: () => false,
      inflightPromise: () => null,
      contentHash: () => 'h2',
      serialize: () => ({}),
      restore: () => {},
    };

    const sel = new SelectorNode({ name: 'sel', children: [child1, child2] });
    const ctx = createCtx();

    // Tick to build up internal state (committedOrder, completedMap, childControllers)
    await sel.tick(ctx); // c1 FAILURE (cached), c2 RUNNING

    // abort() should propagate to both children
    sel.abort();
    expect(abortSpy1).toHaveBeenCalled();
    expect(abortSpy2).toHaveBeenCalled();

    // Internal state should be cleared — serialize returns empty
    const state = sel.serialize();
    expect(state).toEqual({});
  });
});
