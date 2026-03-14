import { describe, it, expect } from 'vitest';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { ParallelNode } from '../composites/parallel.js';
import { RetryNode } from '../decorators/retry.js';
import { TimeoutNode } from '../decorators/timeout.js';
import { GuardNode } from '../decorators/guard.js';
import { TreeBuilder } from '../builder/tree-builder.js';
import { TreeRegistry } from '../config/registry.js';
import { TreeLoader } from '../config/loader.js';
import { TreeScheduler } from '../scheduler/tree-scheduler.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';
import {
  createContext,
  sequentialAction,
  blackboardWriter,
  slowAction,
  collectEvents,
} from './helpers.js';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('Deterministic Integration Tests', () => {
  it('Resilient Pipeline: retry + timeout + sequence', async () => {
    let attempts = 0;

    const unreliable = new ActionNode({
      name: 'unreliable',
      action: async (ctx) => {
        attempts++;
        if (attempts < 3) {
          // Simulate a slow operation that will timeout
          await new Promise((resolve) => setTimeout(resolve, 200));
          return NodeStatus.SUCCESS;
        }
        // Third attempt succeeds quickly
        ctx.blackboard.set('result', 'done');
        return NodeStatus.SUCCESS;
      },
    });

    const timeout = new TimeoutNode({
      name: 'timeout-wrapper',
      child: unreliable,
      timeoutMs: 100,
    });

    const retry = new RetryNode({
      name: 'retry-wrapper',
      child: timeout,
      maxAttempts: 3,
    });

    const writer = new ActionNode(blackboardWriter('final-write', 'pipeline', 'complete'));

    const sequence = new SequenceNode({
      name: 'pipeline',
      children: [retry, writer],
    });

    const ctx = createContext();

    // With the inflight pattern, ActionNode always returns RUNNING on the first
    // tick of each action invocation. Poll until the tree reaches a terminal
    // status. Wall-clock timers (200 ms action / 100 ms timeout) still work
    // correctly because the inflight promise runs in the background between ticks.
    let status = await sequence.tick(ctx);
    while (status === NodeStatus.RUNNING) {
      await flush();
      status = await sequence.tick(ctx);
    }

    expect(status).toBe(NodeStatus.SUCCESS);
    expect(attempts).toBe(3);
    expect(ctx.blackboard.get('result')).toBe('done');
    expect(ctx.blackboard.get('pipeline')).toBe('complete');
  });

  it('RUNNING resumption with Scheduler', async () => {
    let tickCount = 0;

    const tree = new TreeBuilder('resumption-test')
      .sequence('main', (b) => {
        b.action('guard-check', (ctx) => {
          return ctx.blackboard.get('enabled') ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
        });
        b.action('multi-tick', (ctx) => {
          tickCount++;
          if (tickCount < 3) return NodeStatus.RUNNING;
          ctx.blackboard.set('work', 'finished');
          return NodeStatus.SUCCESS;
        });
        b.action('completion', (ctx) => {
          ctx.blackboard.set('completed', true);
          return NodeStatus.SUCCESS;
        });
      })
      .build();

    tree.blackboard.set('enabled', true);

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 10 },
      stopOnStatus: NodeStatus.SUCCESS,
    });

    const tickCompleteEvents: unknown[] = [];
    scheduler.events.on('tick:complete', (data) => tickCompleteEvents.push(data));

    await scheduler.start();

    expect(scheduler.lastStatus).toBe(NodeStatus.SUCCESS);
    expect(tickCount).toBe(3);
    expect(tree.blackboard.get('work')).toBe('finished');
    expect(tree.blackboard.get('completed')).toBe(true);
    // With the inflight model each logical action takes 2 scheduler ticks
    // (start → RUNNING, then poll → result). The tree has three actions that
    // each need at least one inflight cycle, plus multi-tick starts three
    // separate inflight cycles:
    //
    //  Tick 1:  guard-check starts inflight                  → RUNNING
    //  Tick 2:  guard-check polls SUCCESS (cached);
    //           multi-tick starts inflight (tickCount=1)     → RUNNING
    //  Tick 3:  guard-check cached; multi-tick polls RUNNING → RUNNING
    //  Tick 4:  guard-check cached;
    //           multi-tick starts inflight (tickCount=2)     → RUNNING
    //  Tick 5:  guard-check cached; multi-tick polls RUNNING → RUNNING
    //  Tick 6:  guard-check cached;
    //           multi-tick starts inflight (tickCount=3)     → RUNNING
    //  Tick 7:  guard-check cached; multi-tick polls SUCCESS (cached);
    //           completion starts inflight                   → RUNNING
    //  Tick 8:  guard-check cached; multi-tick cached;
    //           completion polls SUCCESS                     → SUCCESS (stop)
    expect(tickCompleteEvents).toHaveLength(8);
  });

  it('Selector fallback with event tracing', async () => {
    const ctx = createContext();
    const enterEvents = collectEvents(ctx, 'node:enter');
    const exitEvents = collectEvents(ctx, 'node:exit');

    // ConditionNodes are not subject to the inflight pattern — they return
    // their result synchronously on every tick. Using them here for the
    // always-failing branches keeps the test single-tick and the event
    // ordering simple to reason about.
    const selector = new SelectorNode({
      name: 'fallback-selector',
      children: [
        new ConditionNode({
          name: 'primary',
          condition: () => false,
        }),
        new ConditionNode({
          name: 'secondary',
          condition: () => false,
        }),
        new ActionNode(blackboardWriter('fallback', 'source', 'fallback')),
      ],
    });

    // Tick 1: primary (FAILURE), secondary (FAILURE), fallback starts inflight → RUNNING
    const status1 = await selector.tick(ctx);
    expect(status1).toBe(NodeStatus.RUNNING);

    // Tick 2: primary (FAILURE, re-evaluated — reactive), secondary (FAILURE),
    //         fallback polls inflight → SUCCESS
    await flush();
    const status2 = await selector.tick(ctx);
    expect(status2).toBe(NodeStatus.SUCCESS);
    expect(ctx.blackboard.get('source')).toBe('fallback');

    // ConditionNodes are reactive so they are re-evaluated on tick 2.
    // The fallback ActionNode is non-reactive: it gets ticked in tick 1
    // (inflight start) and again in tick 2 (poll).
    //
    // Recorded enter events across both ticks:
    //   Tick 1: fallback-selector, primary, secondary, fallback
    //   Tick 2: fallback-selector, primary, secondary, fallback
    const enterNames = enterEvents.map((e) => e.node.name);
    expect(enterNames).toEqual([
      'fallback-selector', 'primary', 'secondary', 'fallback',
      'fallback-selector', 'primary', 'secondary', 'fallback',
    ]);

    // Exit events (children exit before parent in each tick):
    //   Tick 1: primary, secondary, fallback, fallback-selector
    //   Tick 2: primary, secondary, fallback, fallback-selector
    const exitNames = exitEvents.map((e) => e.node.name);
    expect(exitNames).toEqual([
      'primary', 'secondary', 'fallback', 'fallback-selector',
      'primary', 'secondary', 'fallback', 'fallback-selector',
    ]);

    // Statuses across both ticks:
    //   Tick 1: FAILURE, FAILURE, RUNNING, RUNNING
    //   Tick 2: FAILURE, FAILURE, SUCCESS, SUCCESS
    const exitStatuses = exitEvents.map((e) => e.status);
    expect(exitStatuses).toEqual([
      NodeStatus.FAILURE,
      NodeStatus.FAILURE,
      NodeStatus.RUNNING,
      NodeStatus.RUNNING,
      NodeStatus.FAILURE,
      NodeStatus.FAILURE,
      NodeStatus.SUCCESS,
      NodeStatus.SUCCESS,
    ]);
  });

  it('Config-driven tree via Loader + Registry', async () => {
    const registry = new TreeRegistry();

    registry.registerAction('increment', (ctx) => {
      const count = (ctx.blackboard.get<number>('count') ?? 0) + 1;
      ctx.blackboard.set('count', count);
      return NodeStatus.SUCCESS;
    });

    registry.registerAction('double', (ctx) => {
      const count = ctx.blackboard.get<number>('count') ?? 0;
      ctx.blackboard.set('count', count * 2);
      return NodeStatus.SUCCESS;
    });

    registry.registerCondition('isPositive', (ctx) => {
      return (ctx.blackboard.get<number>('count') ?? 0) > 0;
    });

    const yaml = `
name: config-test
root:
  type: sequence
  name: main
  children:
    - type: action
      name: step1
      ref: increment
    - type: action
      name: step2
      ref: double
    - type: condition
      name: check
      ref: isPositive
`;

    const tree = TreeLoader.fromYAML(yaml, registry);

    // ActionNodes use the inflight pattern (RUNNING on first tick, result on
    // second). ConditionNode ('check') is reactive and resolves immediately.
    // Tick until the tree reaches a terminal status.
    //
    //  Tick 1: increment starts inflight                → RUNNING
    //  Tick 2: increment polls SUCCESS (count=1, cached);
    //          double starts inflight                   → RUNNING
    //  Tick 3: increment cached; double polls SUCCESS (count=2, cached);
    //          condition check (ConditionNode) → true   → SUCCESS
    let status = await tree.tick();
    while (status === NodeStatus.RUNNING) {
      await flush();
      status = await tree.tick();
    }

    const snapshot = (tree.blackboard as { toRecord(): Record<string, unknown> }).toRecord();
    expect(status).toBe(NodeStatus.SUCCESS);
    expect(snapshot['count']).toBe(2); // increment to 1, double to 2
  });

  it('Parallel with RUNNING children and successCount policy', async () => {
    let fastTicks = 0;
    let slowTicks = 0;

    const fast = new ActionNode({
      name: 'fast',
      action: (ctx) => {
        fastTicks++;
        ctx.blackboard.set('fast', true);
        return NodeStatus.SUCCESS;
      },
    });

    const medium = new ActionNode({
      ...sequentialAction('medium', [NodeStatus.RUNNING, NodeStatus.SUCCESS]),
    });

    const slow = new ActionNode({
      ...sequentialAction('slow', [NodeStatus.RUNNING, NodeStatus.RUNNING, NodeStatus.SUCCESS]),
    });

    const parallel = new ParallelNode({
      name: 'parallel-test',
      children: [fast, medium, slow],
      strategy: new DefaultParallelStrategy({ successCount: 2 }),
    });

    const ctx = createContext();

    // With the inflight model every action invocation requires two parallel
    // ticks: one to start the inflight and one to poll the result. The
    // sequentialAction helper increments its counter once per action-fn call
    // (i.e. once per inflight start), not once per tree tick.
    //
    // With early policy evaluation, the parallel short-circuits as soon as
    // the successCount threshold is met, without waiting for all children.
    //
    // Logical sequence:
    //   Tick 1: all start inflight                     → RUNNING
    //   Tick 2: fast polls SUCCESS (cached);
    //           medium polls RUNNING; slow polls RUNNING → RUNNING
    //   Tick 3: fast cached; medium & slow start inflight → RUNNING
    //           (medium action fn call 2 → SUCCESS; slow action fn call 2 → RUNNING)
    //   Tick 4: fast cached; medium polls SUCCESS (cached);
    //           slow polls RUNNING
    //           → policy: 2 of 2 resolved ≥ successCount(2) → SUCCESS
    //           (slow is aborted, cycle ends)

    // Tick 1 – all three start inflight
    const status1 = await parallel.tick(ctx);
    expect(status1).toBe(NodeStatus.RUNNING);
    // fast's action fn ran during inflight start, so the blackboard write
    // already happened even though the polled result isn't back yet.
    expect(ctx.blackboard.get('fast')).toBe(true);

    // Tick 2 – fast resolves SUCCESS, medium/slow still RUNNING
    await flush();
    const status2 = await parallel.tick(ctx);
    expect(status2).toBe(NodeStatus.RUNNING);

    // Tick 3 – fast cached; medium and slow start new inflight cycles
    await flush();
    const status3 = await parallel.tick(ctx);
    expect(status3).toBe(NodeStatus.RUNNING);

    // Tick 4 – fast cached; medium resolves SUCCESS; slow still RUNNING
    // Early evaluation: successCount(2) met → SUCCESS, slow aborted
    await flush();
    const status4 = await parallel.tick(ctx);
    expect(status4).toBe(NodeStatus.SUCCESS);
  });
});
