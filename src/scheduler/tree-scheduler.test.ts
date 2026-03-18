import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TreeScheduler } from './tree-scheduler.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { NodeStatus } from '../types.js';
import type { TreeEvents } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { EventEmitter } from '../core/event-emitter.js';

function createTree(status: NodeStatus | (() => NodeStatus)): BehaviorTree {
  const fn = typeof status === 'function' ? status : () => status;
  return new BehaviorTree({
    name: 'test-tree',
    root: new ActionNode({ name: 'root', action: fn }),
  });
}

describe('TreeScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once with schedule type "once"', async () => {
    const tree = createTree(NodeStatus.SUCCESS);
    const tickSpy = vi.spyOn(tree, 'tick');

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'once' },
    });

    await scheduler.start();

    // The scheduler calls tick() once. With inflight, it returns RUNNING,
    // but the scheduler still counts it as one run.
    expect(tickSpy).toHaveBeenCalledOnce();
    expect(scheduler.runCount).toBe(1);
    expect(scheduler.isRunning).toBe(false);
  });

  it('runs on interval and stops manually', async () => {
    const tree = createTree(NodeStatus.SUCCESS);
    const tickSpy = vi.spyOn(tree, 'tick');

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 100 },
    });

    const startPromise = scheduler.start();

    // Advance through 3 intervals
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    await scheduler.stop();
    await startPromise;

    expect(tickSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(scheduler.isRunning).toBe(false);
  });

  it('stops after maxCycles (counts only terminal statuses)', async () => {
    // Alternates RUNNING, SUCCESS to simulate the inflight pattern:
    // each "cycle" takes 2 ticks (RUNNING then SUCCESS).
    let callCount = 0;
    const root = {
      id: 'root', name: 'root', children: [] as any[],
      tick: vi.fn(async () => {
        callCount++;
        return callCount % 2 === 1 ? NodeStatus.RUNNING : NodeStatus.SUCCESS;
      }),
      reset: vi.fn(),
      abort: vi.fn(),
    };
    const tree = new BehaviorTree({ name: 'test-tree', root });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
      maxCycles: 2,
    });

    const startPromise = scheduler.start();

    // Tick 1: RUNNING (cycle not complete)
    await vi.advanceTimersByTimeAsync(50);
    // Tick 2: SUCCESS (cycle 1 complete)
    await vi.advanceTimersByTimeAsync(50);
    // Tick 3: RUNNING (cycle not complete)
    await vi.advanceTimersByTimeAsync(50);
    // Tick 4: SUCCESS (cycle 2 complete — maxCycles reached)
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50); // extra to ensure it stops

    await startPromise;

    expect(scheduler.cycleCount).toBe(2);
    expect(scheduler.runCount).toBe(4); // 4 raw ticks
    expect(scheduler.isRunning).toBe(false);
  });

  it('stops when stopOnStatus is reached', async () => {
    // With inflight model, each tick returns RUNNING first, then the actual
    // status on subsequent ticks. Use a mock BTreeNode to avoid inflight.
    let callCount = 0;
    const root = {
      id: 'root', name: 'root', children: [] as any[],
      tick: vi.fn(async () => {
        callCount++;
        return callCount >= 2 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
      }),
      reset: vi.fn(),
      abort: vi.fn(),
    };
    const tree = new BehaviorTree({ name: 'test-tree', root });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
      stopOnStatus: NodeStatus.SUCCESS,
    });

    const startPromise = scheduler.start();

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);

    await startPromise;

    expect(scheduler.lastStatus).toBe(NodeStatus.SUCCESS);
    expect(scheduler.isRunning).toBe(false);
  });

  it('emits tick:start and tick:complete events', async () => {
    const tree = createTree(NodeStatus.SUCCESS);
    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'once' },
    });

    const startSpy = vi.fn();
    const completeSpy = vi.fn();
    scheduler.events.on('tick:start', startSpy);
    scheduler.events.on('tick:complete', completeSpy);

    await scheduler.start();

    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ runCount: 1 }),
    );
    // With inflight model, the first tick returns RUNNING
    expect(completeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ runCount: 1, status: NodeStatus.RUNNING }),
    );
  });

  it('emits scheduler:stop event', async () => {
    const tree = createTree(NodeStatus.SUCCESS);
    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'once' },
    });

    const stopSpy = vi.fn();
    scheduler.events.on('scheduler:stop', stopSpy);

    await scheduler.start();

    expect(stopSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'maxCycles' }),
    );
  });

  it('emits maxCycles stop reason', async () => {
    let callCount = 0;
    const root = {
      id: 'root', name: 'root', children: [] as any[],
      tick: vi.fn(async () => {
        callCount++;
        return callCount % 2 === 1 ? NodeStatus.RUNNING : NodeStatus.SUCCESS;
      }),
      reset: vi.fn(),
      abort: vi.fn(),
    };
    const tree = new BehaviorTree({ name: 'test-tree', root });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
      maxCycles: 1,
    });

    const stopSpy = vi.fn();
    scheduler.events.on('scheduler:stop', stopSpy);

    const startPromise = scheduler.start();
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await startPromise;

    expect(stopSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'maxCycles' }),
    );
  });

  it('continues on error when onError is "continue"', async () => {
    const tree = createTree(NodeStatus.SUCCESS);
    let callCount = 0;
    vi.spyOn(tree, 'tick').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('boom');
      return NodeStatus.SUCCESS;
    });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
      maxCycles: 1,
      onError: 'continue',
    });

    const errorSpy = vi.fn();
    scheduler.events.on('tick:error', errorSpy);

    const startPromise = scheduler.start();
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await startPromise;

    expect(errorSpy).toHaveBeenCalledOnce();
    // Tick 1: error, tick 2: SUCCESS (1 cycle complete)
    expect(scheduler.runCount).toBe(2);
    expect(scheduler.cycleCount).toBe(1);
  });

  it('multi-tick pipeline resumes RUNNING sequence children', async () => {
    // Use mock BTreeNodes instead of real ActionNodes to avoid inflight
    // complexity with fake timers. This tests the scheduler + reactive sequence.
    let healthChecks = 0;
    const tickCounts = { deploy: 0, health: 0, notify: 0 };

    const deploy = {
      id: 'deploy', name: 'start-deploy', children: [] as any[],
      tick: vi.fn(async () => { tickCounts.deploy++; return NodeStatus.SUCCESS; }),
      reset: vi.fn(), abort: vi.fn(),
    };
    const health = {
      id: 'health', name: 'wait-for-healthy', children: [] as any[],
      tick: vi.fn(async () => {
        tickCounts.health++;
        healthChecks++;
        return healthChecks >= 3 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
      }),
      reset: vi.fn(), abort: vi.fn(),
    };
    const notify = {
      id: 'notify', name: 'notify-slack', children: [] as any[],
      tick: vi.fn(async () => { tickCounts.notify++; return NodeStatus.SUCCESS; }),
      reset: vi.fn(), abort: vi.fn(),
    };

    const root = new SequenceNode({
      name: 'deploy-pipeline',
      children: [deploy, health, notify],
    });

    const tree = new BehaviorTree({ name: 'deploy', root });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 100 },
      stopOnStatus: NodeStatus.SUCCESS,
    });

    const startPromise = scheduler.start();

    // Tick 1: deploy SUCCESS (cached), health RUNNING
    await vi.advanceTimersByTimeAsync(100);
    // Tick 2: deploy cached, health RUNNING
    await vi.advanceTimersByTimeAsync(100);
    // Tick 3: deploy cached, health SUCCESS, notify SUCCESS → tree SUCCESS
    await vi.advanceTimersByTimeAsync(100);

    await startPromise;

    expect(tickCounts.deploy).toBe(1); // cached after first tick
    expect(tickCounts.health).toBe(3);
    expect(tickCounts.notify).toBe(1);
    expect(scheduler.lastStatus).toBe(NodeStatus.SUCCESS);
    expect(scheduler.isRunning).toBe(false);
  });

  it('stops on error when onError is "stop"', async () => {
    const tree = createTree(NodeStatus.SUCCESS);
    vi.spyOn(tree, 'tick').mockImplementation(async () => {
      throw new Error('boom');
    });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
      onError: 'stop',
    });

    const stopSpy = vi.fn();
    scheduler.events.on('scheduler:stop', stopSpy);

    const startPromise = scheduler.start();
    await vi.advanceTimersByTimeAsync(50);
    await startPromise;

    expect(stopSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'error' }),
    );
  });

  it('onError function returning "continue" keeps scheduler running', async () => {
    const tree = createTree(NodeStatus.SUCCESS);
    let callCount = 0;
    vi.spyOn(tree, 'tick').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('tick-error');
      return NodeStatus.SUCCESS;
    });

    const onErrorFn = vi.fn().mockReturnValue('continue');

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
      maxCycles: 1,
      onError: onErrorFn,
    });

    const errorSpy = vi.fn();
    scheduler.events.on('tick:error', errorSpy);

    const startPromise = scheduler.start();
    // Tick 1: throws, onError returns 'continue'
    await vi.advanceTimersByTimeAsync(50);
    // Tick 2: SUCCESS, cycle 1 complete -> maxCycles reached
    await vi.advanceTimersByTimeAsync(50);
    await startPromise;

    expect(onErrorFn).toHaveBeenCalledOnce();
    expect(onErrorFn).toHaveBeenCalledWith(expect.any(Error), 1);
    expect((onErrorFn.mock.calls[0][0] as Error).message).toBe('tick-error');
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(scheduler.runCount).toBe(2);
    expect(scheduler.cycleCount).toBe(1);
    expect(scheduler.isRunning).toBe(false);
  });

  it('onError function returning "stop" halts the scheduler', async () => {
    const tree = createTree(NodeStatus.SUCCESS);
    vi.spyOn(tree, 'tick').mockImplementation(async () => {
      throw new Error('fatal');
    });

    const onErrorFn = vi.fn().mockReturnValue('stop');

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
      onError: onErrorFn,
    });

    const stopSpy = vi.fn();
    scheduler.events.on('scheduler:stop', stopSpy);

    const startPromise = scheduler.start();
    await vi.advanceTimersByTimeAsync(50);
    await startPromise;

    expect(onErrorFn).toHaveBeenCalledOnce();
    expect(onErrorFn).toHaveBeenCalledWith(expect.any(Error), 1);
    expect(stopSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'error' }),
    );
    expect(scheduler.isRunning).toBe(false);
  });

  it('cron schedule executes tick at next occurrence', async () => {
    // Set fake timers to 30 seconds before the minute boundary.
    // Cron '* * * * *' fires every minute, so next occurrence is 30s away.
    vi.setSystemTime(new Date('2025-01-01T00:00:30Z'));

    let callCount = 0;
    const root = {
      id: 'root', name: 'root', children: [] as any[],
      tick: vi.fn(async () => {
        callCount++;
        return NodeStatus.SUCCESS;
      }),
      reset: vi.fn(),
      abort: vi.fn(),
    };
    const tree = new BehaviorTree({ name: 'test-tree', root });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'cron', expression: '* * * * *' },
      stopOnStatus: NodeStatus.SUCCESS,
    });

    const startPromise = scheduler.start();

    // Advance 30s to the next minute boundary — tick should fire
    await vi.advanceTimersByTimeAsync(30_000);

    await startPromise;

    expect(root.tick).toHaveBeenCalledTimes(1);
    expect(scheduler.lastStatus).toBe(NodeStatus.SUCCESS);
    expect(scheduler.isRunning).toBe(false);
  });

  it('start() when already running is a no-op', async () => {
    const tree = createTree(NodeStatus.RUNNING);
    const tickSpy = vi.spyOn(tree, 'tick');

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 100 },
    });

    const startPromise1 = scheduler.start();

    // First tick fires
    await vi.advanceTimersByTimeAsync(100);
    expect(tickSpy).toHaveBeenCalledTimes(1);

    // Calling start() again should be a no-op
    const startPromise2 = scheduler.start();
    // The second start() returns immediately (undefined-ish), not a new loop
    await vi.advanceTimersByTimeAsync(100);
    expect(tickSpy).toHaveBeenCalledTimes(2); // only one scheduler loop running

    await scheduler.stop();
    await startPromise1;
    await startPromise2;

    expect(scheduler.isRunning).toBe(false);
  });

  it('stop() when not running resolves immediately', async () => {
    const tree = createTree(NodeStatus.SUCCESS);

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 100 },
    });

    expect(scheduler.isRunning).toBe(false);

    // stop() on a non-running scheduler should resolve without error
    await scheduler.stop();

    expect(scheduler.isRunning).toBe(false);
  });
});

function createSlowTree(delayMs?: number) {
  let resolveCurrentTick: () => void;
  const tree = {
    tick: vi.fn(async () => {
      if (delayMs !== undefined) {
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        await new Promise<void>(r => { resolveCurrentTick = r; });
      }
      return NodeStatus.RUNNING;
    }),
    reset: vi.fn(),
    abort: vi.fn(),
    events: new EventEmitter<TreeEvents>(),
  };
  return { tree, resolve: () => resolveCurrentTick?.() };
}

describe('TreeScheduler skipOnOverlap and abortOnStop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skipOnOverlap skips tick when previous is in progress', async () => {
    const { tree, resolve } = createSlowTree();

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
      skipOnOverlap: true,
    });

    const startPromise = scheduler.start();

    // First interval fires, tick starts (and blocks on the deferred promise)
    await vi.advanceTimersByTimeAsync(50);
    expect(tree.tick).toHaveBeenCalledTimes(1);

    // Second interval fires while first tick is still in progress — should be skipped
    await vi.advanceTimersByTimeAsync(50);
    expect(tree.tick).toHaveBeenCalledTimes(1);

    // Third interval fires — still skipped
    await vi.advanceTimersByTimeAsync(50);
    expect(tree.tick).toHaveBeenCalledTimes(1);

    // Resolve the first tick and stop
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.stop();
    await startPromise;
  });

  it('skipOnOverlap emits tree:tick:skipped on the tree events', async () => {
    const { tree, resolve } = createSlowTree();

    const skippedSpy = vi.fn();
    tree.events.on('tree:tick:skipped', skippedSpy);

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
      skipOnOverlap: true,
    });

    const startPromise = scheduler.start();

    // First tick starts
    await vi.advanceTimersByTimeAsync(50);

    // Second interval fires — skipped, event emitted
    await vi.advanceTimersByTimeAsync(50);
    expect(skippedSpy).toHaveBeenCalledTimes(1);
    expect(skippedSpy).toHaveBeenCalledWith(expect.objectContaining({ timestamp: expect.any(Number) }));

    // Third interval fires — skipped again
    await vi.advanceTimersByTimeAsync(50);
    expect(skippedSpy).toHaveBeenCalledTimes(2);

    resolve();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.stop();
    await startPromise;
  });

  it('skipOnOverlap false (default) allows ticks to queue normally', async () => {
    const tree = createTree(NodeStatus.RUNNING);

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
    });

    const startPromise = scheduler.start();

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);

    expect(scheduler.runCount).toBe(3);

    await scheduler.stop();
    await startPromise;
  });

  it('abortOnStop calls tree.abort() on stop', async () => {
    const { tree } = createSlowTree(10);

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
      abortOnStop: true,
    });

    const startPromise = scheduler.start();

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(10);
    await scheduler.stop();
    await startPromise;

    expect(tree.abort).toHaveBeenCalledOnce();
  });

  it('stop() awaits in-flight tick before resolving', async () => {
    const { tree, resolve } = createSlowTree();

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
      skipOnOverlap: true,
      abortOnStop: true,
    });

    const startPromise = scheduler.start();

    // First interval fires, tick starts (blocks on deferred promise)
    await vi.advanceTimersByTimeAsync(50);
    expect(tree.tick).toHaveBeenCalledTimes(1);

    // stop() should not resolve until the in-flight tick finishes
    let stopResolved = false;
    const stopPromise = scheduler.stop().then(() => { stopResolved = true; });

    // Drain microtasks — stop should still be pending
    await vi.advanceTimersByTimeAsync(0);
    expect(stopResolved).toBe(false);

    // Resolve the in-flight tick — now stop can complete
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    await stopPromise;

    expect(stopResolved).toBe(true);
    // abort should be called after the tick finishes, not during
    expect(tree.abort).toHaveBeenCalledOnce();
    await startPromise;
  });

  it('stop() awaits in-flight tick on non-overlap path before resolving', async () => {
    const { tree, resolve } = createSlowTree();

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
      // No skipOnOverlap — default (non-overlap) path
      abortOnStop: true,
    });

    const startPromise = scheduler.start();

    // First interval fires, tick starts (blocks on deferred promise)
    await vi.advanceTimersByTimeAsync(50);
    expect(tree.tick).toHaveBeenCalledTimes(1);

    // stop() should not resolve until the in-flight tick finishes
    let stopResolved = false;
    const stopPromise = scheduler.stop().then(() => { stopResolved = true; });

    // Drain microtasks — stop should still be pending
    await vi.advanceTimersByTimeAsync(0);
    expect(stopResolved).toBe(false);

    // Resolve the in-flight tick — now stop can complete
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    await stopPromise;

    expect(stopResolved).toBe(true);
    expect(tree.abort).toHaveBeenCalledOnce();
    await startPromise;
  });

  it('abortOnStop false (default) does not call abort', async () => {
    const { tree } = createSlowTree(10);

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
    });

    const startPromise = scheduler.start();

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(10);
    await scheduler.stop();
    await startPromise;

    expect(tree.abort).not.toHaveBeenCalled();
  });

  it('stop() then start() on same instance does not race on _isRunning', async () => {
    const tree = createTree(NodeStatus.RUNNING);

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
    });

    // First run
    const startPromise1 = scheduler.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(scheduler.isRunning).toBe(true);

    // Stop fully — stop() awaits _startPromise so the old start()'s
    // finally block has completed before stop() returns.
    await scheduler.stop();
    expect(scheduler.isRunning).toBe(false);

    // Restart on the same instance — _isRunning must stay true and not
    // get clobbered by the old start()'s finally block.
    const startPromise2 = scheduler.start();
    expect(scheduler.isRunning).toBe(true);

    // Let the new scheduler tick
    await vi.advanceTimersByTimeAsync(50);
    expect(scheduler.isRunning).toBe(true);

    await vi.advanceTimersByTimeAsync(50);
    expect(scheduler.isRunning).toBe(true);

    // Stop the second run
    await scheduler.stop();
    expect(scheduler.isRunning).toBe(false);

    await startPromise1;
    await startPromise2;
  });
});
