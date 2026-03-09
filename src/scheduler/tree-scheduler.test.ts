import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TreeScheduler } from './tree-scheduler.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';

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

  it('stops after maxRuns', async () => {
    const tree = createTree(NodeStatus.SUCCESS);

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
      maxRuns: 3,
    });

    const startPromise = scheduler.start();

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50); // extra to ensure it stops

    await startPromise;

    expect(scheduler.runCount).toBe(3);
    expect(scheduler.isRunning).toBe(false);
  });

  it('stops when stopOnStatus is reached', async () => {
    let callCount = 0;
    const tree = createTree(() => {
      callCount++;
      return callCount >= 2 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
    });

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
    expect(completeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ runCount: 1, status: NodeStatus.SUCCESS }),
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
      expect.objectContaining({ reason: 'maxRuns' }),
    );
  });

  it('resets tree between ticks by default', async () => {
    const tree = createTree(NodeStatus.SUCCESS);
    const resetSpy = vi.spyOn(tree, 'reset');

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
      maxRuns: 2,
    });

    const startPromise = scheduler.start();
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await startPromise;

    // Reset is called before each tick after the first
    expect(resetSpy).toHaveBeenCalled();
  });

  it('does not reset tree when resetBetweenTicks is false', async () => {
    const tree = createTree(NodeStatus.SUCCESS);
    const resetSpy = vi.spyOn(tree, 'reset');

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 50 },
      maxRuns: 2,
      resetBetweenTicks: false,
    });

    const startPromise = scheduler.start();
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await startPromise;

    expect(resetSpy).not.toHaveBeenCalled();
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
      maxRuns: 2,
      onError: 'continue',
    });

    const errorSpy = vi.fn();
    scheduler.events.on('tick:error', errorSpy);

    const startPromise = scheduler.start();
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await startPromise;

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(scheduler.runCount).toBe(2);
  });

  it('multi-tick pipeline resumes RUNNING sequence children', async () => {
    let healthChecks = 0;
    const tickCounts = { deploy: 0, health: 0, notify: 0 };

    const root = new SequenceNode({
      name: 'deploy-pipeline',
      children: [
        new ActionNode({
          name: 'start-deploy',
          action: () => { tickCounts.deploy++; return NodeStatus.SUCCESS; },
        }),
        new ActionNode({
          name: 'wait-for-healthy',
          action: () => {
            tickCounts.health++;
            healthChecks++;
            return healthChecks >= 3 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
          },
        }),
        new ActionNode({
          name: 'notify-slack',
          action: () => { tickCounts.notify++; return NodeStatus.SUCCESS; },
        }),
      ],
    });

    const tree = new BehaviorTree({ name: 'deploy', root });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 100 },
      resetBetweenTicks: false,
      stopOnStatus: NodeStatus.SUCCESS,
    });

    const startPromise = scheduler.start();

    // Tick 1: deploy SUCCESS, health RUNNING
    await vi.advanceTimersByTimeAsync(100);
    // Tick 2: health RUNNING
    await vi.advanceTimersByTimeAsync(100);
    // Tick 3: health SUCCESS, notify SUCCESS → tree SUCCESS → scheduler stops
    await vi.advanceTimersByTimeAsync(100);

    await startPromise;

    expect(tickCounts.deploy).toBe(1);
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
});
