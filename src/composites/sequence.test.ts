import { describe, it, expect, vi } from 'vitest';
import { SequenceNode } from './sequence.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext, ExecutionStrategy } from '../types.js';
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

describe('SequenceNode', () => {
  it('returns SUCCESS when all children succeed', async () => {
    const node = new SequenceNode({
      name: 'seq',
      children: [actionNode('a', NodeStatus.SUCCESS), actionNode('b', NodeStatus.SUCCESS)],
    });
    const ctx = createContext();
    // Tick 1: a starts inflight → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    // Tick 2: a completes SUCCESS, b starts inflight → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    // Tick 3: b completes SUCCESS → sequence SUCCESS
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('returns FAILURE when first child fails', async () => {
    const node = new SequenceNode({
      name: 'seq',
      children: [actionNode('a', NodeStatus.FAILURE), actionNode('b', NodeStatus.SUCCESS)],
    });
    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
  });

  it('returns FAILURE when second child fails', async () => {
    const node = new SequenceNode({
      name: 'seq',
      children: [actionNode('a', NodeStatus.SUCCESS), actionNode('b', NodeStatus.FAILURE)],
    });
    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
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
      id: '2', name: 'b', children: [], tick: tickSpy, reset: () => {}, abort: () => {},
    };
    const node = new SequenceNode({
      name: 'seq',
      children: [actionNode('a', NodeStatus.FAILURE), secondChild],
    });
    const ctx = createContext();
    // Tick 1: a starts inflight → RUNNING (b not ticked yet)
    await node.tick(ctx);
    expect(tickSpy).not.toHaveBeenCalled();
    await flush();
    // Tick 2: a completes FAILURE → b still not ticked
    await node.tick(ctx);
    expect(tickSpy).not.toHaveBeenCalled();
  });

  it('resumes from RUNNING child on next tick', async () => {
    let healthCheckCalls = 0;
    const tickCounts = { deploy: 0, health: 0, notify: 0 };

    const deploy: BTreeNode = {
      id: 'deploy', name: 'deploy', children: [],
      tick: async () => { tickCounts.deploy++; return NodeStatus.SUCCESS; },
      reset: () => {}, abort: () => {},
    };
    const health: BTreeNode = {
      id: 'health', name: 'health', children: [],
      tick: async () => {
        tickCounts.health++;
        healthCheckCalls++;
        return healthCheckCalls >= 3 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
      },
      reset: () => {}, abort: () => {},
    };
    const notify: BTreeNode = {
      id: 'notify', name: 'notify', children: [],
      tick: async () => { tickCounts.notify++; return NodeStatus.SUCCESS; },
      reset: () => {}, abort: () => {},
    };

    const node = new SequenceNode({ name: 'seq', children: [deploy, health, notify] });
    const ctx = createContext();

    // Tick 1: deploy succeeds (cached), health returns RUNNING → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    // Tick 2: deploy cached, health still RUNNING → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    // Tick 3: deploy cached, health succeeds, notify succeeds → SUCCESS
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);

    // deploy is non-reactive mock, cached after first tick
    expect(tickCounts.deploy).toBe(1);
    expect(tickCounts.health).toBe(3);
    expect(tickCounts.notify).toBe(1);
  });

  it('clears cycle on FAILURE and re-evaluates from start', async () => {
    let call = 0;
    const tickCounts = { a: 0, b: 0 };

    const a: BTreeNode = {
      id: 'a', name: 'a', children: [],
      tick: async () => { tickCounts.a++; return NodeStatus.SUCCESS; },
      reset: () => {}, abort: () => {},
    };
    const b: BTreeNode = {
      id: 'b', name: 'b', children: [],
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

    // Tick 1: a SUCCESS (cached), b RUNNING → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(tickCounts.a).toBe(1);

    // Tick 2: a cached (SUCCESS), b FAILURE → cycle cleared, FAILURE
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
    // a was cached, not re-ticked
    expect(tickCounts.a).toBe(1);

    // Tick 3: new cycle — a ticked again (cache was cleared), b FAILURE
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
    expect(tickCounts.a).toBe(2);
  });

  it('reset() clears running child state', async () => {
    const tickCounts = { a: 0, b: 0 };
    const a: BTreeNode = {
      id: 'a', name: 'a', children: [],
      tick: async () => { tickCounts.a++; return NodeStatus.SUCCESS; },
      reset: () => {}, abort: () => {},
    };
    const b: BTreeNode = {
      id: 'b', name: 'b', children: [],
      tick: async () => { tickCounts.b++; return NodeStatus.RUNNING; },
      reset: () => {}, abort: () => {},
    };

    const node = new SequenceNode({ name: 'seq', children: [a, b] });
    const ctx = createContext();

    await node.tick(ctx); // a=SUCCESS (cached), b=RUNNING
    expect(tickCounts.a).toBe(1);

    node.reset(); // clears all cycle state
    await node.tick(ctx); // new cycle — a ticked again
    expect(tickCounts.a).toBe(2);
  });

  describe('order commitment', () => {
    it('calls strategy.order() once per execution cycle even with RUNNING child', async () => {
      let healthCalls = 0;
      const health: BTreeNode = {
        id: 'health', name: 'health', children: [],
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

      // Tick 1: action 'a' starts inflight → RUNNING
      await node.tick(ctx);
      await flush();
      // Tick 2: action 'a' completes (cached), health RUNNING
      await node.tick(ctx);
      // Tick 3: action 'a' cached, health RUNNING
      await node.tick(ctx);
      // Tick 4: action 'a' cached, health SUCCESS → cycle ends
      await node.tick(ctx);

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

      // Cycle 1: tick 1 starts action (RUNNING), tick 2 completes (SUCCESS)
      await node.tick(ctx);
      await flush();
      await node.tick(ctx);

      // Cycle 2: tick 3 starts action (RUNNING), tick 4 completes (SUCCESS)
      await node.tick(ctx);
      await flush();
      await node.tick(ctx);

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

      // Cycle 1: tick 1 starts action (RUNNING), tick 2 completes (FAILURE)
      await node.tick(ctx);
      await flush();
      await node.tick(ctx);

      // Cycle 2: tick 3 starts action (RUNNING), tick 4 completes (FAILURE)
      await node.tick(ctx);
      await flush();
      await node.tick(ctx);

      expect(orderSpy).toHaveBeenCalledTimes(2);
    });

    it('re-consults strategy after reset()', async () => {
      let calls = 0;
      const child: BTreeNode = {
        id: 'c', name: 'c', children: [],
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
        id: 'a', name: 'a', children: [],
        tick: async () => NodeStatus.SUCCESS,
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
      id: name, name, children: [],
      tick: async () => { order.push(name); return NodeStatus.SUCCESS; },
      reset: () => {}, abort: () => {},
    });
    const node = new SequenceNode({
      name: 'seq',
      children: [trackingNode('a'), trackingNode('b')],
      strategy: reverseStrategy,
    });
    const ctx = createContext();
    // First tick: b is ticked (SUCCESS, cached), a is ticked (SUCCESS, cached) → SUCCESS
    await node.tick(ctx);
    expect(order).toEqual(['b', 'a']);
  });

  describe('reactive sequence', () => {
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
      ctx.blackboard.set('flag', true);

      const cond = new ConditionNode({
        name: 'cond',
        condition: (c) => c.blackboard.get('flag') === true,
      });

      const { action, resolve } = createDeferredAction();

      const seq = new SequenceNode({
        name: 'seq',
        children: [cond, action],
      });

      // Tick 1: Condition succeeds, Action starts (RUNNING)
      const t1 = seq.tick(ctx);
      await flush();
      expect(await t1).toBe(NodeStatus.RUNNING);

      // Tick 2: Condition re-checked (still true), Action still RUNNING
      const t2 = seq.tick(ctx);
      await flush();
      expect(await t2).toBe(NodeStatus.RUNNING);

      // Change blackboard to make condition fail
      ctx.blackboard.set('flag', false);

      // Tick 3: Condition re-checked (fails), returns FAILURE
      const t3p = seq.tick(ctx);
      // Resolve the pending action so it doesn't hang
      resolve(NodeStatus.SUCCESS);
      await flush();
      expect(await t3p).toBe(NodeStatus.FAILURE);
    });

    it('caches completed non-reactive children', async () => {
      const ctx = createContext();
      ctx.blackboard.set('flag', true);

      const cond = new ConditionNode({
        name: 'cond',
        condition: (c) => c.blackboard.get('flag') === true,
      });

      // Use a spy-wrapped ActionNode to track tick() calls at the node level
      let action1TickCount = 0;
      const action1 = new ActionNode({
        name: 'action1',
        action: async () => NodeStatus.SUCCESS,
      });
      const action1OrigTick = action1.tick.bind(action1);
      action1.tick = async (c: TreeContext) => {
        action1TickCount++;
        return action1OrigTick(c);
      };

      const { action: action2, resolve: resolve2 } = createDeferredAction();

      const seq = new SequenceNode({
        name: 'seq',
        children: [cond, action1, action2],
      });

      // Tick 1: Cond succeeds, Action1 starts inflight (RUNNING from inflight model)
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(action1TickCount).toBe(1);

      // Tick 2: Cond re-ticked, Action1 re-ticked (inflight resolves → SUCCESS),
      //         Action2 starts inflight (RUNNING)
      await flush();
      const t2 = seq.tick(ctx);
      await flush();
      expect(await t2).toBe(NodeStatus.RUNNING);
      expect(action1TickCount).toBe(2);

      // Tick 3: Cond re-ticked, Action1 cached (not re-ticked), Action2 polled
      const t3 = seq.tick(ctx);
      await flush();
      expect(await t3).toBe(NodeStatus.RUNNING);
      expect(action1TickCount).toBe(2); // Action1 was NOT re-ticked

      resolve2(NodeStatus.SUCCESS);
    });

    it('clears cycle cache on cycle end', async () => {
      const ctx = createContext();

      let actionCallCount = 0;
      const action = new ActionNode({
        name: 'action',
        action: async () => {
          actionCallCount++;
          return NodeStatus.SUCCESS;
        },
      });

      const seq = new SequenceNode({
        name: 'seq',
        children: [action],
      });

      // Tick 1: action starts inflight (RUNNING)
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(actionCallCount).toBe(1);

      // Tick 2: inflight result ready → SUCCESS, cycle ends
      await flush();
      expect(await seq.tick(ctx)).toBe(NodeStatus.SUCCESS);

      // Tick 3: new cycle — action must re-execute (cycle cache was cleared)
      // abort() was called on children during clearCycle, clearing inflight state
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(actionCallCount).toBe(2);

      // Tick 4: inflight result ready → SUCCESS
      await flush();
      expect(await seq.tick(ctx)).toBe(NodeStatus.SUCCESS);
    });

    it('scoped abort on failure', async () => {
      const ctx = createContext();
      ctx.blackboard.set('flag', true);

      let capturedSignal: AbortSignal | undefined;
      const action = new ActionNode({
        name: 'action',
        action: async (c) => {
          capturedSignal = c.signal;
          return new Promise<NodeStatus>(() => {
            // Never resolves — simulates a long-running action
          });
        },
      });

      const seq = new SequenceNode({
        name: 'seq',
        children: [
          new ConditionNode({
            name: 'cond',
            condition: (c) => c.blackboard.get('flag') === true,
          }),
          action,
        ],
      });

      // Tick 1: Cond succeeds, action starts inflight (RUNNING)
      const t1 = seq.tick(ctx);
      await flush();
      expect(await t1).toBe(NodeStatus.RUNNING);

      // The action should have received a scoped signal
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(false);

      // Now make condition fail
      ctx.blackboard.set('flag', false);

      // Tick 2: Cond fails → abort all children, scoped controller aborted
      const t2 = seq.tick(ctx);
      await flush();
      expect(await t2).toBe(NodeStatus.FAILURE);

      // The captured signal should be aborted
      expect(capturedSignal!.aborted).toBe(true);
    });

    it('abort() clears all state', async () => {
      const ctx = createContext();

      let actionCallCount = 0;
      const action = new ActionNode({
        name: 'action',
        action: async () => {
          actionCallCount++;
          return NodeStatus.SUCCESS;
        },
      });

      const seq = new SequenceNode({
        name: 'seq',
        children: [action],
      });

      // Tick 1: action starts inflight (RUNNING)
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(actionCallCount).toBe(1);

      // Abort clears all state (including children's inflight state)
      seq.abort();

      // Next tick starts a fresh cycle — action re-executes from scratch
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(actionCallCount).toBe(2);
    });

    it('reset() clears all state', async () => {
      const ctx = createContext();

      let actionCallCount = 0;
      const action = new ActionNode({
        name: 'action',
        action: async () => {
          actionCallCount++;
          return NodeStatus.SUCCESS;
        },
      });

      const seq = new SequenceNode({
        name: 'seq',
        children: [action],
      });

      // Tick 1: action starts inflight (RUNNING)
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(actionCallCount).toBe(1);

      // Reset clears all state (including children's inflight state)
      seq.reset();

      // Next tick starts a fresh cycle — action re-executes from scratch
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(actionCallCount).toBe(2);
    });
  });
});
