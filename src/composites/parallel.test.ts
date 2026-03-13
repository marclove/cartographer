import { describe, it, expect, vi } from 'vitest';
import { ParallelNode } from './parallel.js';
import { NodeStatus } from '../types.js';
import type { TreeContext, ParallelStrategy, ParallelPolicy, BTreeNode } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';

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

describe('ParallelNode', () => {
  it('returns SUCCESS when all children succeed (default policy)', async () => {
    const node = new ParallelNode({
      name: 'par',
      children: [actionNode('a', NodeStatus.SUCCESS), actionNode('b', NodeStatus.SUCCESS)],
    });
    const ctx = createContext();
    // Tick 1: both start inflight → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    // Tick 2: both complete SUCCESS → SUCCESS
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('returns FAILURE when any child fails (default policy requires all)', async () => {
    const node = new ParallelNode({
      name: 'par',
      children: [actionNode('a', NodeStatus.SUCCESS), actionNode('b', NodeStatus.FAILURE)],
    });
    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
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
    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
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
    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
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
    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
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
      id: name, name, children: [],
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
    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });
});

describe('ParallelNode — reactive tick model', () => {
  /** Create a stub BTreeNode (non-reactive) with controllable tick results. */
  function stubNode(
    name: string,
    tickFn: () => NodeStatus,
  ): BTreeNode & { tickCount: number } {
    const node: BTreeNode & { tickCount: number } = {
      id: name,
      name,
      children: [],
      tickCount: 0,
      tick: async () => {
        node.tickCount++;
        return tickFn();
      },
      reset: () => {},
      abort: () => {},
    };
    return node;
  }

  it('reactive children (conditions) are re-ticked every tick', async () => {
    let conditionTickCount = 0;
    // ConditionNode is reactive — always re-ticked
    const condition = new ConditionNode({
      name: 'cond',
      condition: () => {
        conditionTickCount++;
        return true;
      },
    });

    // Non-reactive stub that returns RUNNING then SUCCESS
    let actionCallCount = 0;
    const action = stubNode('act', () => {
      actionCallCount++;
      return actionCallCount >= 2 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
    });

    const node = new ParallelNode({
      name: 'par',
      children: [condition, action],
    });

    const ctx = createContext();

    // Tick 1: condition SUCCESS (reactive), action RUNNING => RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(conditionTickCount).toBe(1);
    expect(action.tickCount).toBe(1);

    // Tick 2: condition re-ticked (reactive), action polled => both SUCCESS
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(conditionTickCount).toBe(2); // re-ticked because reactive
    expect(action.tickCount).toBe(2);
  });

  it('completed non-reactive children are cached within a cycle', async () => {
    // action1 completes SUCCESS immediately
    const action1 = stubNode('a1', () => NodeStatus.SUCCESS);

    // action2 returns RUNNING first, then SUCCESS
    let action2CallCount = 0;
    const action2 = stubNode('a2', () => {
      action2CallCount++;
      return action2CallCount >= 2 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
    });

    const node = new ParallelNode({
      name: 'par',
      children: [action1, action2],
    });

    const ctx = createContext();

    // Tick 1: action1 SUCCESS (cached), action2 RUNNING => RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(action1.tickCount).toBe(1);
    expect(action2.tickCount).toBe(1);

    // Tick 2: action1 NOT re-ticked (cached), action2 polled => SUCCESS
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(action1.tickCount).toBe(1); // not re-ticked!
    expect(action2.tickCount).toBe(2);
  });

  it('cycle ends when all children resolve and clears state', async () => {
    const action = stubNode('act', () => NodeStatus.SUCCESS);

    const node = new ParallelNode({
      name: 'par',
      children: [action],
    });

    const ctx = createContext();

    // Tick 1: action SUCCESS, cycle ends
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(action.tickCount).toBe(1);

    // Tick 2: new cycle — action is ticked again (cache was cleared)
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(action.tickCount).toBe(2);
  });

  it('policy is committed once per cycle', async () => {
    let policyCallCount = 0;

    const strategy: ParallelStrategy = {
      policy: async () => {
        policyCallCount++;
        return {};
      },
    };

    // Returns RUNNING twice, then SUCCESS
    let actionCallCount = 0;
    const action = stubNode('act', () => {
      actionCallCount++;
      return actionCallCount >= 3 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
    });

    const node = new ParallelNode({
      name: 'par',
      children: [action],
      strategy,
    });

    const ctx = createContext();

    // Tick 1: policy called, action RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(policyCallCount).toBe(1);

    // Tick 2: policy NOT called again (committed), action RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(policyCallCount).toBe(1);

    // Tick 3: policy NOT called again, action SUCCESS, cycle ends
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(policyCallCount).toBe(1);

    // Tick 4: new cycle — policy called again
    actionCallCount = 0;
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(policyCallCount).toBe(2);
  });

  it('abort() and reset() clear all cycle state', async () => {
    const action = stubNode('act', () => NodeStatus.SUCCESS);

    const node = new ParallelNode({
      name: 'par',
      children: [action],
    });

    const ctx = createContext();

    // Tick to populate cycle state
    await node.tick(ctx);
    expect(action.tickCount).toBe(1);

    // reset() clears state — next tick starts a fresh cycle
    node.reset();
    await node.tick(ctx);
    expect(action.tickCount).toBe(2); // re-ticked after reset

    // Build up state with a RUNNING child and then abort
    let callCount = 0;
    const runningChild = stubNode('running', () => {
      callCount++;
      return callCount >= 2 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
    });

    const node2 = new ParallelNode({
      name: 'par2',
      children: [runningChild],
    });

    await node2.tick(ctx); // RUNNING — cycle state populated
    expect(runningChild.tickCount).toBe(1);

    node2.abort(); // should clear all cycle state

    callCount = 0; // reset counter
    await node2.tick(ctx); // fresh cycle — child is ticked again
    expect(runningChild.tickCount).toBe(2);
  });

  it('scoped abort controllers per child cascade from parent signal', async () => {
    const receivedSignals: AbortSignal[] = [];

    const child1: BTreeNode = {
      id: 'c1',
      name: 'c1',
      children: [],
      tick: async (ctx: TreeContext) => {
        receivedSignals.push(ctx.signal!);
        return NodeStatus.RUNNING;
      },
      reset: () => {},
      abort: () => {},
    };

    const child2: BTreeNode = {
      id: 'c2',
      name: 'c2',
      children: [],
      tick: async (ctx: TreeContext) => {
        receivedSignals.push(ctx.signal!);
        return NodeStatus.RUNNING;
      },
      reset: () => {},
      abort: () => {},
    };

    const parentController = new AbortController();
    const ctx: TreeContext = {
      blackboard: new InMemoryBlackboard(),
      events: new EventEmitter<TreeEvents>(),
      signal: parentController.signal,
    };

    const node = new ParallelNode({
      name: 'par',
      children: [child1, child2],
    });

    await node.tick(ctx);

    // Each child gets its own signal (not the parent's)
    expect(receivedSignals).toHaveLength(2);
    expect(receivedSignals[0]).not.toBe(parentController.signal);
    expect(receivedSignals[1]).not.toBe(parentController.signal);
    expect(receivedSignals[0]).not.toBe(receivedSignals[1]);

    // Signals are not yet aborted
    expect(receivedSignals[0].aborted).toBe(false);
    expect(receivedSignals[1].aborted).toBe(false);

    // Parent abort cascades to child signals
    parentController.abort();
    expect(receivedSignals[0].aborted).toBe(true);
    expect(receivedSignals[1].aborted).toBe(true);
  });
});
