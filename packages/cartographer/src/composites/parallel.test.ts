import { describe, it, expect, vi } from 'vitest';
import { ParallelNode } from './parallel.js';
import { NodeStatus } from '../types.js';
import type { TreeContext, ParallelStrategy, ParallelPolicy, BTreeNode } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import { SessionRegistry } from '../core/session-registry.js';
import type { TreeEvents } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
    sessions: new SessionRegistry(),
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
      interrupt: () => {},
      hasInflightWork: () => false,
      inflightPromise: () => null,
      contentHash: () => `stub-${name}`,
      serialize: () => ({}),
      restore: () => {},
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

  it('failureCount policy short-circuits before all children resolve', async () => {
    // child1 fails immediately, child2 stays RUNNING
    const child1 = stubNode('c1', () => NodeStatus.FAILURE);
    let c2Calls = 0;
    const child2 = stubNode('c2', () => {
      c2Calls++;
      return NodeStatus.RUNNING;
    });

    const node = new ParallelNode({
      name: 'par',
      children: [child1, child2],
      strategy: new DefaultParallelStrategy({ failureCount: 1 }),
    });

    const ctx = createContext();

    // Tick 1: child1 FAILURE, child2 RUNNING. Policy says failureCount >= 1 → FAILURE
    // Should short-circuit immediately, not wait for child2
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
  });

  it('successCount policy short-circuits before all children resolve', async () => {
    // child1 and child2 succeed immediately, child3 stays RUNNING
    const child1 = stubNode('c1', () => NodeStatus.SUCCESS);
    const child2 = stubNode('c2', () => NodeStatus.SUCCESS);
    let c3Calls = 0;
    const child3 = stubNode('c3', () => {
      c3Calls++;
      return NodeStatus.RUNNING;
    });

    const node = new ParallelNode({
      name: 'par',
      children: [child1, child2, child3],
      strategy: new DefaultParallelStrategy({ successCount: 2 }),
    });

    const ctx = createContext();

    // Tick 1: child1 SUCCESS, child2 SUCCESS, child3 RUNNING.
    // Policy says successCount >= 2 → SUCCESS. Short-circuit.
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('default policy (all must succeed) short-circuits on first failure', async () => {
    const child1 = stubNode('c1', () => NodeStatus.FAILURE);
    const child2 = stubNode('c2', () => NodeStatus.RUNNING);

    const node = new ParallelNode({
      name: 'par',
      children: [child1, child2],
    });

    const ctx = createContext();

    // Default policy: zero failures allowed. child1 failed → FAILURE immediately
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
  });

  it('early policy termination aborts remaining RUNNING children', async () => {
    const child1 = stubNode('c1', () => NodeStatus.FAILURE);
    const abortSpy = vi.fn();
    const child2: BTreeNode = {
      id: 'c2', name: 'c2', children: [],
      tick: async () => NodeStatus.RUNNING,
      reset: () => {}, abort: abortSpy,
    };

    const node = new ParallelNode({
      name: 'par',
      children: [child1, child2],
      strategy: new DefaultParallelStrategy({ failureCount: 1 }),
    });

    await node.tick(createContext());
    expect(abortSpy).toHaveBeenCalled();
  });

  it('successPercentage defers until all children resolve', async () => {
    // With RUNNING children we can't compute a meaningful percentage,
    // so successPercentage should wait for all children to resolve.
    const child1 = stubNode('c1', () => NodeStatus.SUCCESS);
    let c2Calls = 0;
    const child2 = stubNode('c2', () => {
      c2Calls++;
      return c2Calls >= 2 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
    });

    const node = new ParallelNode({
      name: 'par',
      children: [child1, child2],
      strategy: new DefaultParallelStrategy({ successPercentage: 50 }),
    });

    const ctx = createContext();

    // Tick 1: child1 SUCCESS, child2 RUNNING. Can't evaluate percentage yet.
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);

    // Tick 2: child1 cached, child2 SUCCESS. 100% >= 50% → SUCCESS
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('serialize() returns completedMap as hash-to-status mapping after partial tick', async () => {
    // action1 completes SUCCESS, action2 stays RUNNING across multiple ticks
    const action1 = new ActionNode({ name: 'a1', action: () => NodeStatus.SUCCESS });
    const action2 = new ActionNode({ name: 'a2', action: () => NodeStatus.RUNNING });

    const node = new ParallelNode({
      name: 'par',
      children: [action1, action2],
    });

    const ctx = createContext();

    // Tick 1: both actions launch inflight → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    // Tick 2: action1 resolves SUCCESS (cached), action2 resolves RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);

    const state = node.serialize();
    expect(state.completedMap).toBeDefined();
    // The completedMap should contain action1's hash → SUCCESS
    expect(state.completedMap![action1.contentHash()]).toBe(NodeStatus.SUCCESS);
    // action2 returned RUNNING, not in completedMap
    expect(state.completedMap![action2.contentHash()]).toBeUndefined();
  });

  it('restore() rebuilds completedMap, subsequent tick skips already-completed non-reactive children', async () => {
    // Use stub nodes (not ActionNode) to avoid inflight async overhead
    let a1Calls = 0;
    const action1 = stubNode('a1', () => {
      a1Calls++;
      return NodeStatus.SUCCESS;
    });
    let a2Calls = 0;
    const action2 = stubNode('a2', () => {
      a2Calls++;
      return a2Calls >= 2 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
    });

    const node = new ParallelNode({
      name: 'par',
      children: [action1, action2],
    });

    // Build a hashToNode map using the child references themselves
    // (restore matches by BTreeNode identity via hashToNode lookup)
    const hashToNode = new Map<string, BTreeNode>();
    hashToNode.set('stub-a1', action1);
    hashToNode.set('stub-a2', action2);

    // Restore state as if action1 already completed with SUCCESS
    const savedState = {
      completedMap: {
        'stub-a1': NodeStatus.SUCCESS as NodeStatus,
      },
    };
    node.restore(savedState, hashToNode);

    const ctx = createContext();

    // Tick: action1 should be skipped (already completed), action2 ticked
    // action2 returns RUNNING on first call
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(a1Calls).toBe(0); // skipped because restored into completedMap
    expect(a2Calls).toBe(1);

    // Tick again: action2 returns SUCCESS
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(a1Calls).toBe(0); // still skipped
    expect(a2Calls).toBe(2);
  });

  it('restore() skips unknown hashes gracefully', () => {
    const action1 = new ActionNode({ name: 'a1', action: () => NodeStatus.SUCCESS });

    const node = new ParallelNode({
      name: 'par',
      children: [action1],
    });

    const hashToNode = new Map<string, BTreeNode>();
    hashToNode.set(action1.contentHash(), action1);

    // State contains an unknown hash that doesn't map to any child
    const savedState = {
      completedMap: {
        'unknown-hash-abc123': NodeStatus.SUCCESS,
        [action1.contentHash()]: NodeStatus.FAILURE,
      },
    };

    // Should not throw
    node.restore(savedState, hashToNode);

    // Verify the known hash was restored by serializing back
    const reserialized = node.serialize();
    expect(reserialized.completedMap).toBeDefined();
    expect(reserialized.completedMap![action1.contentHash()]).toBe(NodeStatus.FAILURE);
    // Unknown hash should NOT be in the restored state
    expect(reserialized.completedMap!['unknown-hash-abc123']).toBeUndefined();
  });

  it('parent signal already aborted before tick — child controllers aborted immediately', async () => {
    const receivedSignals: AbortSignal[] = [];

    const child1: BTreeNode = {
      id: 'c1', name: 'c1', children: [],
      tick: async (ctx: TreeContext) => {
        receivedSignals.push(ctx.signal!);
        return NodeStatus.RUNNING;
      },
      reset: () => {}, abort: () => {},
      interrupt: () => {},
      hasInflightWork: () => false,
      inflightPromise: () => null,
      contentHash: () => 'c1-hash',
      serialize: () => ({}),
      restore: () => {},
    };

    const parentController = new AbortController();
    parentController.abort(); // Already aborted before tick

    const ctx: TreeContext = {
      blackboard: new InMemoryBlackboard(),
      events: new EventEmitter<TreeEvents>(),
      signal: parentController.signal,
    };

    const node = new ParallelNode({
      name: 'par',
      children: [child1],
    });

    await node.tick(ctx);

    // Child should have received an already-aborted signal
    expect(receivedSignals).toHaveLength(1);
    expect(receivedSignals[0].aborted).toBe(true);
  });

  it('abort() propagates to all child AbortControllers and calls child.abort()', async () => {
    const abortSpies = [vi.fn(), vi.fn()];
    const receivedSignals: AbortSignal[] = [];

    function makeChild(idx: number): BTreeNode {
      return {
        id: `c${idx}`, name: `c${idx}`, children: [],
        tick: async (ctx: TreeContext) => {
          receivedSignals.push(ctx.signal!);
          return NodeStatus.RUNNING;
        },
        reset: () => {},
        abort: abortSpies[idx],
        interrupt: () => {},
        hasInflightWork: () => false,
        inflightPromise: () => null,
        contentHash: () => `c${idx}-hash`,
        serialize: () => ({}),
        restore: () => {},
      };
    }

    const node = new ParallelNode({
      name: 'par',
      children: [makeChild(0), makeChild(1)],
    });

    const ctx = createContext();
    await node.tick(ctx);

    // Both children are RUNNING, signals not yet aborted
    expect(receivedSignals).toHaveLength(2);
    expect(receivedSignals[0].aborted).toBe(false);
    expect(receivedSignals[1].aborted).toBe(false);

    // abort() should abort all child controllers and call child.abort()
    node.abort();

    expect(receivedSignals[0].aborted).toBe(true);
    expect(receivedSignals[1].aborted).toBe(true);
    expect(abortSpies[0]).toHaveBeenCalled();
    expect(abortSpies[1]).toHaveBeenCalled();
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
