import { describe, it, expect, vi, afterEach } from 'vitest';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { ParallelNode } from '../composites/parallel.js';
import { RetryNode } from '../decorators/retry.js';
import { RepeatNode } from '../decorators/repeat.js';
import { TimeoutNode } from '../decorators/timeout.js';
import { GuardNode } from '../decorators/guard.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { createContext } from './helpers.js';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Creates an ActionNode that tracks call count.
 * `resultFn` receives the call index (0-based) and returns the status.
 */
function tracked(name: string, resultFn: (callIndex: number) => NodeStatus) {
  let calls = 0;
  const node = new ActionNode({
    name,
    action: () => resultFn(calls++),
  });
  return { node, getCalls: () => calls };
}

/** Creates a ConditionNode that reads a blackboard key as a boolean. */
function bbCondition(name: string, key: string) {
  return new ConditionNode({
    name,
    condition: (ctx) => ctx.blackboard.get(key) === true,
  });
}

describe('Reactive Tick Model', () => {
  describe('condition preemption', () => {
    it('condition change mid-cycle aborts RUNNING action', async () => {
      const ctx = createContext({ enabled: true });
      const action = tracked('work', () => NodeStatus.SUCCESS);

      const seq = new SequenceNode({
        name: 'seq',
        children: [bbCondition('guard', 'enabled'), action.node],
      });

      // Tick 1: condition passes, action starts inflight → RUNNING
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(action.getCalls()).toBe(1);

      await flush();

      // Condition changes between ticks
      ctx.blackboard.set('enabled', false);

      // Tick 2: condition re-evaluated → FAILURE → sequence aborts, never polls action
      expect(await seq.tick(ctx)).toBe(NodeStatus.FAILURE);

      // Tick 3 (new cycle): restore condition, action starts fresh
      ctx.blackboard.set('enabled', true);
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(action.getCalls()).toBe(2); // action re-executed from scratch
    });

    it('higher-priority reactive branch preempts RUNNING lower branch', async () => {
      const ctx = createContext({ fast_path: false });

      // High-priority: a condition (reactive — always re-ticked by selector)
      const highPriority = bbCondition('fast-check', 'fast_path');

      // Low-priority: slow action that will be RUNNING
      const slowAction = tracked('slow', () => NodeStatus.SUCCESS);

      const sel = new SelectorNode({
        name: 'sel',
        children: [highPriority, slowAction.node],
      });

      // Tick 1: condition false → FAILURE, slow action starts → RUNNING
      expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(slowAction.getCalls()).toBe(1);

      await flush();

      // Enable fast path between ticks
      ctx.blackboard.set('fast_path', true);

      // Tick 2: condition re-ticked (reactive) → SUCCESS → selector returns SUCCESS
      // Slow action is aborted (preempted by higher-priority branch)
      expect(await sel.tick(ctx)).toBe(NodeStatus.SUCCESS);
      // Slow action was never polled — its inflight result is discarded
      expect(slowAction.getCalls()).toBe(1);
    });
  });

  describe('cycle-based completion caching', () => {
    it('completed non-reactive actions are not re-executed within a cycle', async () => {
      const ctx = createContext({ proceed: true });
      const action1 = tracked('action1', () => NodeStatus.SUCCESS);
      const action2 = tracked('action2', () => NodeStatus.SUCCESS);

      const seq = new SequenceNode({
        name: 'seq',
        children: [bbCondition('check', 'proceed'), action1.node, action2.node],
      });

      // Tick 1: condition passes, action1 starts → RUNNING
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(action1.getCalls()).toBe(1);
      expect(action2.getCalls()).toBe(0);

      await flush();

      // Tick 2: condition re-ticked (reactive), action1 polled → SUCCESS (cached),
      // action2 starts → RUNNING
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(action1.getCalls()).toBe(1); // not re-called
      expect(action2.getCalls()).toBe(1);

      await flush();

      // Tick 3: condition re-ticked, action1 cached (not ticked at all),
      // action2 polled → SUCCESS → sequence SUCCESS
      expect(await seq.tick(ctx)).toBe(NodeStatus.SUCCESS);
      expect(action1.getCalls()).toBe(1); // still 1 — cached
      expect(action2.getCalls()).toBe(1); // polled, not re-called
    });
  });

  describe('nested composites', () => {
    it('inner sequence abort does not affect sibling branches in selector', async () => {
      const ctx = createContext({ inner_ok: true });

      // Inner sequence: condition + action
      const innerAction = tracked('inner-work', () => NodeStatus.SUCCESS);
      const innerSeq = new SequenceNode({
        name: 'inner-seq',
        children: [bbCondition('inner-check', 'inner_ok'), innerAction.node],
      });

      // Fallback action
      const fallback = tracked('fallback', () => NodeStatus.SUCCESS);

      const sel = new SelectorNode({
        name: 'outer-sel',
        children: [innerSeq, fallback.node],
      });

      // Tick 1: inner condition passes, inner action starts → RUNNING → selector RUNNING
      expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(innerAction.getCalls()).toBe(1);
      expect(fallback.getCalls()).toBe(0);

      await flush();

      // Inner condition fails between ticks
      ctx.blackboard.set('inner_ok', false);

      // Tick 2: inner seq re-evaluates → condition FAILURE → inner seq FAILURE
      // Selector tries fallback → starts → RUNNING
      expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(fallback.getCalls()).toBe(1);

      await flush();

      // Tick 3: inner seq condition still fails → FAILURE (cached in selector)
      // fallback polled → SUCCESS → selector SUCCESS
      expect(await sel.tick(ctx)).toBe(NodeStatus.SUCCESS);
    });
  });

  describe('guard decorator', () => {
    it('guard in a sequence is re-evaluated when its condition changes mid-cycle', async () => {
      const ctx = createContext({ gate: true });

      // Guard wrapping an action — as a child of a sequence alongside another action.
      // The guard's condition reads from the blackboard.
      const guardedAction = tracked('guarded', () => NodeStatus.SUCCESS);
      const guard = new GuardNode({
        name: 'gate-guard',
        condition: (c) => c.blackboard.get('gate') === true,
        child: guardedAction.node,
      });

      const followUp = tracked('follow-up', () => NodeStatus.SUCCESS);

      const seq = new SequenceNode({
        name: 'seq',
        children: [guard, followUp.node],
      });

      // Tick 1: guard condition passes → guarded action starts → RUNNING
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(guardedAction.getCalls()).toBe(1);

      await flush();

      // Tick 2: guard re-evaluated (reactive!) → condition still true →
      // guarded action polled → SUCCESS → follow-up starts → RUNNING
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);

      await flush();

      // Change gate between ticks — guard must be re-evaluated, not cached
      ctx.blackboard.set('gate', false);

      // Tick 3: guard re-evaluated → condition false → FAILURE →
      // sequence returns FAILURE (guard is reactive, not cached as SUCCESS)
      expect(await seq.tick(ctx)).toBe(NodeStatus.FAILURE);
    });

    it('aborts child when condition changes to false', async () => {
      const ctx = createContext({ allowed: true });

      const action = tracked('guarded-work', () => NodeStatus.SUCCESS);
      const guard = new GuardNode({
        name: 'guard',
        condition: (c) => c.blackboard.get('allowed') === true,
        child: action.node,
      });

      // Tick 1: condition passes, action starts → RUNNING
      expect(await guard.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(action.getCalls()).toBe(1);

      await flush();

      // Condition changes
      ctx.blackboard.set('allowed', false);

      // Tick 2: condition fails → guard aborts child → FAILURE
      expect(await guard.tick(ctx)).toBe(NodeStatus.FAILURE);

      // Tick 3: restore condition, action starts fresh
      ctx.blackboard.set('allowed', true);
      expect(await guard.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(action.getCalls()).toBe(2);
    });
  });

  describe('parallel completion tracking', () => {
    it('completed non-reactive children are cached, reactive children re-ticked', async () => {
      const ctx = createContext({ healthy: true });

      const action1 = tracked('a1', () => NodeStatus.SUCCESS);
      const action2 = tracked('a2', (i) => i === 0 ? NodeStatus.SUCCESS : NodeStatus.SUCCESS);

      const parallel = new ParallelNode({
        name: 'par',
        children: [bbCondition('health', 'healthy'), action1.node, action2.node],
      });

      // Tick 1: condition SUCCESS, both actions start → RUNNING
      expect(await parallel.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(action1.getCalls()).toBe(1);
      expect(action2.getCalls()).toBe(1);

      await flush();

      // Tick 2: condition re-ticked (reactive), actions polled → both SUCCESS
      // All resolved → policy check → all SUCCESS → SUCCESS
      expect(await parallel.tick(ctx)).toBe(NodeStatus.SUCCESS);
      expect(action1.getCalls()).toBe(1); // polled, not re-called
      expect(action2.getCalls()).toBe(1); // polled, not re-called
    });

    it('still-RUNNING actions are polled while completed are cached', async () => {
      const ctx = createContext({ ok: true });

      const fast = tracked('fast', () => NodeStatus.SUCCESS);

      // Slow action: stays RUNNING for multiple polls
      let slowResolve: (s: NodeStatus) => void;
      const slowNode = new ActionNode({
        name: 'slow',
        action: () => new Promise<NodeStatus>((r) => { slowResolve = r; }),
      });

      const parallel = new ParallelNode({
        name: 'par',
        children: [bbCondition('check', 'ok'), fast.node, slowNode],
      });

      // Tick 1: all start — fast and slow both inflight → RUNNING
      expect(await parallel.tick(ctx)).toBe(NodeStatus.RUNNING);

      await flush(); // fast resolves

      // Tick 2: condition re-ticked, fast polled → SUCCESS (cached), slow still RUNNING
      expect(await parallel.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(fast.getCalls()).toBe(1);

      // Tick 3: same — fast cached, slow still RUNNING
      expect(await parallel.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(fast.getCalls()).toBe(1); // not re-called

      // Resolve slow action
      slowResolve!(NodeStatus.SUCCESS);
      await flush();

      // Tick 4: slow polled → SUCCESS → all resolved → SUCCESS
      expect(await parallel.tick(ctx)).toBe(NodeStatus.SUCCESS);
    });
  });

  describe('retry across ticks', () => {
    it('attempt counter persists across RUNNING ticks', async () => {
      const ctx = createContext();

      // Action: FAILURE, FAILURE, SUCCESS (by call index)
      const action = tracked('flaky', (i) =>
        i < 2 ? NodeStatus.FAILURE : NodeStatus.SUCCESS,
      );

      const retry = new RetryNode({
        name: 'retry',
        child: action.node,
        maxAttempts: 3,
      });

      // Tick 1: attempt 0 — action starts (will return FAILURE) → inflight → RUNNING
      expect(await retry.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(action.getCalls()).toBe(1);

      await flush();

      // Tick 2: polls → FAILURE → attempt 1 → starts again (will return FAILURE) → RUNNING
      expect(await retry.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(action.getCalls()).toBe(2);

      await flush();

      // Tick 3: polls → FAILURE → attempt 2 → starts again (will return SUCCESS) → RUNNING
      expect(await retry.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(action.getCalls()).toBe(3);

      await flush();

      // Tick 4: polls → SUCCESS → retry returns SUCCESS
      expect(await retry.tick(ctx)).toBe(NodeStatus.SUCCESS);
    });
  });

  describe('repeat across ticks', () => {
    it('iteration counter persists across RUNNING ticks', async () => {
      const ctx = createContext();

      const action = tracked('repeated', () => NodeStatus.SUCCESS);

      const repeat = new RepeatNode({
        name: 'repeat-3',
        child: action.node,
        count: 3,
      });

      // Tick 1: iteration 0 — action starts → RUNNING
      expect(await repeat.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(action.getCalls()).toBe(1);

      await flush();

      // Tick 2: polls → SUCCESS → iteration 1 → starts again → RUNNING
      expect(await repeat.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(action.getCalls()).toBe(2);

      await flush();

      // Tick 3: polls → SUCCESS → iteration 2 → starts again → RUNNING
      expect(await repeat.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(action.getCalls()).toBe(3);

      await flush();

      // Tick 4: polls → SUCCESS → iteration 3 = count → repeat done → SUCCESS
      expect(await repeat.tick(ctx)).toBe(NodeStatus.SUCCESS);
    });
  });

  describe('timeout across ticks', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('fires based on wall-clock time across multiple ticks', async () => {
      let now = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);

      const ctx = createContext();

      // Action that never resolves on its own
      const neverNode = new ActionNode({
        name: 'never',
        action: () => new Promise<NodeStatus>(() => {}),
      });

      const timeout = new TimeoutNode({
        name: 'timeout',
        child: neverNode,
        timeoutMs: 100,
      });

      // Tick 1: child starts → RUNNING, timeout records start time
      expect(await timeout.tick(ctx)).toBe(NodeStatus.RUNNING);

      // Tick 2 at t+50: not yet timed out
      now = 1050;
      expect(await timeout.tick(ctx)).toBe(NodeStatus.RUNNING);

      // Tick 3 at t+120: timed out → child aborted → FAILURE
      now = 1120;
      expect(await timeout.tick(ctx)).toBe(NodeStatus.FAILURE);
    });
  });

  describe('tree.start() tick loop', () => {
    it('fires multiple ticks and stops via handle', async () => {
      let actionCalls = 0;
      const action = new ActionNode({
        name: 'counter',
        action: () => { actionCalls++; return NodeStatus.RUNNING; },
      });

      const tree = new BehaviorTree({ name: 'loop-test', root: action });
      const handle = tree.start({ intervalMs: 20 });

      await new Promise((r) => setTimeout(r, 120));
      await handle.stop();

      // With 20ms intervals over ~120ms, expect several ticks
      expect(actionCalls).toBeGreaterThanOrEqual(2);
    });

    it('stops the loop when AbortSignal is triggered', async () => {
      const action = new ActionNode({
        name: 'signal-test',
        action: () => NodeStatus.RUNNING,
      });

      const tree = new BehaviorTree({ name: 'signal-test', root: action });
      const ac = new AbortController();
      const handle = tree.start({ intervalMs: 20, signal: ac.signal });

      await new Promise((r) => setTimeout(r, 60));
      ac.abort();
      // Give it time to stop
      await new Promise((r) => setTimeout(r, 50));

      // Starting a new loop should work (old one stopped)
      const handle2 = tree.start({ intervalMs: 20 });
      await handle2.stop();
    });

    it('throws if a loop is already running', () => {
      const action = new ActionNode({
        name: 'double-start',
        action: () => NodeStatus.RUNNING,
      });

      const tree = new BehaviorTree({ name: 'double-test', root: action });
      const handle = tree.start({ intervalMs: 100 });

      expect(() => tree.start({ intervalMs: 100 })).toThrow('already running');

      // Cleanup
      handle.stop();
    });
  });

  describe('strategy commitment', () => {
    it('sync default strategy commits order on first tick of cycle', async () => {
      const ctx = createContext();
      const a1 = tracked('a1', () => NodeStatus.SUCCESS);
      const a2 = tracked('a2', () => NodeStatus.SUCCESS);

      const seq = new SequenceNode({
        name: 'seq',
        children: [a1.node, a2.node],
      });

      // Tick 1: a1 starts → RUNNING
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      await flush();

      // Tick 2: a1 polled → SUCCESS (cached), a2 starts → RUNNING
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      await flush();

      // Tick 3: a1 cached, a2 polled → SUCCESS → sequence done
      expect(await seq.tick(ctx)).toBe(NodeStatus.SUCCESS);
      expect(a1.getCalls()).toBe(1);
      expect(a2.getCalls()).toBe(1);
    });

    it('async strategy is awaited within same tick (no extra delay)', async () => {
      const ctx = createContext();
      const a1 = tracked('a1', () => NodeStatus.SUCCESS);

      // Async strategy that returns children in reverse order
      const asyncStrategy = {
        order: async (children: readonly import('../types.js').BTreeNode[]) => {
          await Promise.resolve();
          return [...children].reverse();
        },
      };

      const seq = new SequenceNode({
        name: 'seq',
        children: [a1.node],
        strategy: asyncStrategy,
      });

      // Tick 1: strategy awaited, a1 starts → RUNNING (same tick, no extra delay)
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(a1.getCalls()).toBe(1);

      await flush();

      // Tick 2: a1 polled → SUCCESS
      expect(await seq.tick(ctx)).toBe(NodeStatus.SUCCESS);
    });
  });
});
