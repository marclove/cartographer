import { describe, it, expect } from 'vitest';
import { NodeStatus } from '../types.js';
import { ConditionNode } from '../nodes/condition.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { TreeScheduler } from '../scheduler/tree-scheduler.js';
import { EventEmitter } from '../core/event-emitter.js';
import type { TreeEvents } from '../types.js';
import { InMemoryBlackboard } from '../core/blackboard.js';

// A minimal BehaviorTree-compatible object whose tick() can throw,
// bypassing BaseNode's internal error-to-FAILURE conversion.
function makeFakeTree(tickFn: () => Promise<NodeStatus>): BehaviorTree {
  const fake = {
    name: 'fake',
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
    tick: tickFn,
    reset: () => {},
    abort: () => {},
    run: async () => ({ status: NodeStatus.SUCCESS, blackboard: {} }),
  } as unknown as BehaviorTree;
  return fake;
}

describe('Scheduler Resilience', () => {
  it('onError: continue — recovers from errors and keeps ticking', async () => {
    let tickCount = 0;

    const tree = makeFakeTree(async () => {
      tickCount++;
      if (tickCount === 1) throw new Error('transient failure');
      return NodeStatus.SUCCESS;
    });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 10 },
      onError: 'continue',
      maxCycles: 2,
    });

    const errorEvents: unknown[] = [];
    const completeEvents: unknown[] = [];
    scheduler.events.on('tick:error', (data) => errorEvents.push(data));
    scheduler.events.on('tick:complete', (data) => completeEvents.push(data));

    const stopEvents: unknown[] = [];
    scheduler.events.on('scheduler:stop', (data) => stopEvents.push(data));

    await scheduler.start();

    expect(errorEvents).toHaveLength(1);
    expect(completeEvents).toHaveLength(2);
    expect(scheduler.runCount).toBe(3);
    expect(scheduler.cycleCount).toBe(2);
    expect(stopEvents).toHaveLength(1);
    expect((stopEvents[0] as any).reason).toBe('maxCycles');
  });

  it('onError callback — receives error and runCount, controls stop', async () => {
    const callbackArgs: Array<{ error: Error; runCount: number }> = [];

    const tree = makeFakeTree(async () => {
      throw new Error('boom');
    });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 10 },
      onError: (error, runCount) => {
        callbackArgs.push({ error, runCount });
        return runCount < 3 ? 'continue' : 'stop';
      },
    });

    const stopEvents: unknown[] = [];
    scheduler.events.on('scheduler:stop', (data) => stopEvents.push(data));

    await scheduler.start();

    expect(callbackArgs).toHaveLength(3);
    expect(callbackArgs[0].runCount).toBe(1);
    expect(callbackArgs[1].runCount).toBe(2);
    expect(callbackArgs[2].runCount).toBe(3);
    expect(callbackArgs[0].error.message).toBe('boom');
    expect(stopEvents).toHaveLength(1);
    expect((stopEvents[0] as any).reason).toBe('error');
  });

  it('maxCycles + stopOnStatus — stopOnStatus takes precedence when hit first', async () => {
    // Use makeFakeTree to bypass ActionNode's inflight pattern and directly
    // control the status returned per scheduler tick.
    let tickCount = 0;

    const tree = makeFakeTree(async () => {
      tickCount++;
      return tickCount >= 3 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
    });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 10 },
      maxCycles: 5,
      stopOnStatus: NodeStatus.SUCCESS,
    });

    const stopEvents: unknown[] = [];
    scheduler.events.on('scheduler:stop', (data) => stopEvents.push(data));

    await scheduler.start();

    expect(scheduler.runCount).toBe(3);
    expect(scheduler.lastStatus).toBe(NodeStatus.SUCCESS);
    expect(stopEvents).toHaveLength(1);
    expect((stopEvents[0] as any).reason).toBe('stopOnStatus');
  });

  it('event ordering completeness — once scheduler fires events in order', async () => {
    const eventLog: Array<{ type: string; data: unknown }> = [];

    // Use ConditionNode rather than ActionNode: conditions return SUCCESS/FAILURE
    // immediately without the inflight pattern, so 'once' captures SUCCESS directly.
    const tree = new BehaviorTree({
      name: 'event-order',
      root: new ConditionNode({
        name: 'simple',
        condition: () => true,
      }),
    });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'once' },
    });

    scheduler.events.on('tick:start', (data) => eventLog.push({ type: 'tick:start', data }));
    scheduler.events.on('tick:complete', (data) => eventLog.push({ type: 'tick:complete', data }));
    scheduler.events.on('scheduler:stop', (data) => eventLog.push({ type: 'scheduler:stop', data }));

    await scheduler.start();

    expect(eventLog).toHaveLength(3);
    expect(eventLog[0].type).toBe('tick:start');
    expect(eventLog[1].type).toBe('tick:complete');
    expect(eventLog[2].type).toBe('scheduler:stop');

    const startData = eventLog[0].data as any;
    expect(startData.runCount).toBe(1);
    expect(startData.timestamp).toBeInstanceOf(Date);

    const completeData = eventLog[1].data as any;
    expect(completeData.runCount).toBe(1);
    expect(completeData.status).toBe(NodeStatus.SUCCESS);
    expect(typeof completeData.durationMs).toBe('number');

    const stopData = eventLog[2].data as any;
    expect(stopData.reason).toBe('maxCycles');
  });
});
