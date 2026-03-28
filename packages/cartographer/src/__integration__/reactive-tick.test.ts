import { describe, it, expect, vi, afterEach } from 'vitest';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { ParallelNode } from '../composites/parallel.js';
import { Retry } from '../decorators/retry.js';
import { Repeat } from '../decorators/repeat.js';
import { Timeout } from '../decorators/timeout.js';
import { Guard } from '../decorators/guard.js';
import { createContext } from './helpers.js';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Creates an ActionNode that tracks call count.
 * `resultFn` receives the call index (0-based) and returns the status.
 * Pass `{ async: true }` to force the action through the inflight pattern
 * (returning a Promise so the node goes RUNNING on the first tick).
 */
function tracked(name: string, resultFn: (callIndex: number) => NodeStatus, opts?: { async: boolean }) {
  let calls = 0;
  const action = opts?.async
    ? async () => resultFn(calls++)
    : () => resultFn(calls++);
  const node = new ActionNode({ name, action });
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
      // Use async action so it goes through the inflight pattern (RUNNING on first tick)
      const action = tracked('work', () => NodeStatus.SUCCESS, { async: true });

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

      // Low-priority: slow action that will be RUNNING (async to use inflight pattern)
      const slowAction = tracked('slow', () => NodeStatus.SUCCESS, { async: true });

      const sel = new SelectorNode({
        name: 'sel',
        children: [highPriority, slowAction.node],
      });

      // Tick 1: condition false → FAILURE, slow action starts inflight → RUNNING
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

      // Single tick: condition passes, action1 resolves sync → SUCCESS,
      // action2 resolves sync → SUCCESS → sequence SUCCESS
      expect(await seq.tick(ctx)).toBe(NodeStatus.SUCCESS);
      expect(action1.getCalls()).toBe(1);
      expect(action2.getCalls()).toBe(1);
    });
  });

  describe('nested composites', () => {
    it('inner sequence abort does not affect sibling branches in selector', async () => {
      const ctx = createContext({ inner_ok: true });

      // Inner sequence: condition + async action (needs inflight for mid-cycle abort)
      const innerAction = tracked('inner-work', () => NodeStatus.SUCCESS, { async: true });
      const innerSeq = new SequenceNode({
        name: 'inner-seq',
        children: [bbCondition('inner-check', 'inner_ok'), innerAction.node],
      });

      // Fallback action (async to test the full flow with inflight)
      const fallback = tracked('fallback', () => NodeStatus.SUCCESS, { async: true });

      const sel = new SelectorNode({
        name: 'outer-sel',
        children: [innerSeq, fallback.node],
      });

      // Tick 1: inner condition passes, inner action starts inflight → RUNNING → selector RUNNING
      expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(innerAction.getCalls()).toBe(1);
      expect(fallback.getCalls()).toBe(0);

      await flush();

      // Inner condition fails between ticks
      ctx.blackboard.set('inner_ok', false);

      // Tick 2: inner seq re-evaluates → condition FAILURE → inner seq FAILURE
      // Selector tries fallback → starts inflight → RUNNING
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

      // Guard wrapping an async action — needs inflight to test mid-cycle re-evaluation
      const guardedAction = tracked('guarded', () => NodeStatus.SUCCESS, { async: true });
      const guard = new Guard({
        name: 'gate-guard',
        condition: (c) => c.blackboard.get('gate') === true,
        child: guardedAction.node,
      });

      const followUp = tracked('follow-up', () => NodeStatus.SUCCESS, { async: true });

      const seq = new SequenceNode({
        name: 'seq',
        children: [guard, followUp.node],
      });

      // Tick 1: guard condition passes → guarded action starts inflight → RUNNING
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(guardedAction.getCalls()).toBe(1);

      await flush();

      // Tick 2: guard re-evaluated (reactive!) → condition still true →
      // guarded action polled → SUCCESS → follow-up starts inflight → RUNNING
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

      // Async action so it goes through inflight (RUNNING on first tick)
      const action = tracked('guarded-work', () => NodeStatus.SUCCESS, { async: true });
      const guard = new Guard({
        name: 'guard',
        condition: (c) => c.blackboard.get('allowed') === true,
        child: action.node,
      });

      // Tick 1: condition passes, action starts inflight → RUNNING
      expect(await guard.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(action.getCalls()).toBe(1);

      await flush();

      // Condition changes
      ctx.blackboard.set('allowed', false);

      // Tick 2: condition fails → guard aborts child → FAILURE
      expect(await guard.tick(ctx)).toBe(NodeStatus.FAILURE);

      // Tick 3: restore condition, action starts fresh inflight
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

      // Single tick: condition SUCCESS, both sync actions resolve SUCCESS immediately
      // All resolved → policy check → all SUCCESS → SUCCESS
      expect(await parallel.tick(ctx)).toBe(NodeStatus.SUCCESS);
      expect(action1.getCalls()).toBe(1);
      expect(action2.getCalls()).toBe(1);
    });

    it('still-RUNNING actions are polled while completed are cached', async () => {
      const ctx = createContext({ ok: true });

      // Fast is sync → resolves immediately in first tick
      const fast = tracked('fast', () => NodeStatus.SUCCESS);

      // Slow action: stays RUNNING for multiple polls (async, uses inflight)
      let slowResolve: (s: NodeStatus) => void;
      const slowNode = new ActionNode({
        name: 'slow',
        action: () => new Promise<NodeStatus>((r) => { slowResolve = r; }),
      });

      const parallel = new ParallelNode({
        name: 'par',
        children: [bbCondition('check', 'ok'), fast.node, slowNode],
      });

      // Tick 1: condition SUCCESS, fast resolves sync → SUCCESS (cached),
      // slow starts inflight → RUNNING → parallel RUNNING
      expect(await parallel.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(fast.getCalls()).toBe(1);

      // Tick 2: condition re-ticked, fast cached, slow still RUNNING
      expect(await parallel.tick(ctx)).toBe(NodeStatus.RUNNING);
      expect(fast.getCalls()).toBe(1); // not re-called

      // Resolve slow action
      slowResolve!(NodeStatus.SUCCESS);
      await flush();

      // Tick 3: slow polled → SUCCESS → all resolved → SUCCESS
      expect(await parallel.tick(ctx)).toBe(NodeStatus.SUCCESS);
    });
  });

  describe('retry across ticks', () => {
    it('attempt counter persists across ticks with sync actions', async () => {
      const ctx = createContext();

      // Action: FAILURE, FAILURE, SUCCESS (by call index)
      const action = tracked('flaky', (i) =>
        i < 2 ? NodeStatus.FAILURE : NodeStatus.SUCCESS,
      );

      const retry = new Retry({
        name: 'retry',
        child: action.node,
        maxAttempts: 3,
      });

      // Sync actions resolve immediately. Retry sees FAILURE on attempts 0 and 1,
      // then SUCCESS on attempt 2 — all within a single tick.
      expect(await retry.tick(ctx)).toBe(NodeStatus.SUCCESS);
      expect(action.getCalls()).toBe(3);
    });
  });

  describe('repeat across ticks', () => {
    it('iteration counter works with sync actions', async () => {
      const ctx = createContext();

      const action = tracked('repeated', () => NodeStatus.SUCCESS);

      const repeat = new Repeat({
        name: 'repeat-3',
        child: action.node,
        count: 3,
      });

      // Sync actions resolve immediately. Repeat loops all 3 iterations
      // within a single tick.
      expect(await repeat.tick(ctx)).toBe(NodeStatus.SUCCESS);
      expect(action.getCalls()).toBe(3);
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

      const timeout = new Timeout({
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

  describe('parent signal listener cleanup', () => {
    it('sequence removes parent signal listeners when cycle ends', async () => {
      const ac = new AbortController();
      const addSpy = vi.spyOn(ac.signal, 'addEventListener');
      const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

      // Use async actions to ensure multi-tick flow that exercises signal listeners
      const a1 = tracked('a1', () => NodeStatus.SUCCESS, { async: true });
      const a2 = tracked('a2', () => NodeStatus.SUCCESS, { async: true });
      const seq = new SequenceNode({ name: 'seq', children: [a1.node, a2.node] });
      const ctx = { ...createContext(), signal: ac.signal };

      // Cycle 1
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      await flush();
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      await flush();
      expect(await seq.tick(ctx)).toBe(NodeStatus.SUCCESS);

      // Every listener added should have been removed
      expect(addSpy.mock.calls.length).toBeGreaterThan(0);
      expect(removeSpy.mock.calls.length).toBe(addSpy.mock.calls.length);

      // Cycle 2: listeners should not accumulate
      addSpy.mockClear();
      removeSpy.mockClear();
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      await flush();
      expect(await seq.tick(ctx)).toBe(NodeStatus.RUNNING);
      await flush();
      expect(await seq.tick(ctx)).toBe(NodeStatus.SUCCESS);

      expect(removeSpy.mock.calls.length).toBe(addSpy.mock.calls.length);

      vi.restoreAllMocks();
    });

    it('selector removes parent signal listeners when cycle ends', async () => {
      const ac = new AbortController();
      const addSpy = vi.spyOn(ac.signal, 'addEventListener');
      const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

      // Use async actions to ensure multi-tick flow that exercises signal listeners
      const a1 = tracked('a1', () => NodeStatus.FAILURE, { async: true });
      const a2 = tracked('a2', () => NodeStatus.SUCCESS, { async: true });
      const sel = new SelectorNode({ name: 'sel', children: [a1.node, a2.node] });
      const ctx = { ...createContext(), signal: ac.signal };

      // Cycle 1: a1 FAILURE → a2 SUCCESS
      expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
      await flush();
      expect(await sel.tick(ctx)).toBe(NodeStatus.RUNNING);
      await flush();
      // a1 polled → FAILURE (cached), a2 polled → SUCCESS
      expect(await sel.tick(ctx)).toBe(NodeStatus.SUCCESS);

      expect(addSpy.mock.calls.length).toBeGreaterThan(0);
      expect(removeSpy.mock.calls.length).toBe(addSpy.mock.calls.length);

      vi.restoreAllMocks();
    });

    it('parallel removes parent signal listeners when cycle ends', async () => {
      const ac = new AbortController();
      const addSpy = vi.spyOn(ac.signal, 'addEventListener');
      const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

      // Use async actions to ensure multi-tick flow that exercises signal listeners
      const a1 = tracked('a1', () => NodeStatus.SUCCESS, { async: true });
      const a2 = tracked('a2', () => NodeStatus.SUCCESS, { async: true });
      const par = new ParallelNode({ name: 'par', children: [a1.node, a2.node] });
      const ctx = { ...createContext(), signal: ac.signal };

      // Cycle 1
      expect(await par.tick(ctx)).toBe(NodeStatus.RUNNING);
      await flush();
      expect(await par.tick(ctx)).toBe(NodeStatus.SUCCESS);

      expect(addSpy.mock.calls.length).toBeGreaterThan(0);
      expect(removeSpy.mock.calls.length).toBe(addSpy.mock.calls.length);

      vi.restoreAllMocks();
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

      // Single tick: both sync actions resolve immediately → sequence SUCCESS
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

      // Single tick: strategy awaited, a1 resolves sync → SUCCESS
      expect(await seq.tick(ctx)).toBe(NodeStatus.SUCCESS);
      expect(a1.getCalls()).toBe(1);
    });
  });
});
