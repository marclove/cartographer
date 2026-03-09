import { describe, it, expect } from 'vitest';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
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
    const status = await sequence.tick(ctx);

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
      resetBetweenTicks: false,
      stopOnStatus: NodeStatus.SUCCESS,
    });

    const tickCompleteEvents: unknown[] = [];
    scheduler.events.on('tick:complete', (data) => tickCompleteEvents.push(data));

    await scheduler.start();

    expect(scheduler.lastStatus).toBe(NodeStatus.SUCCESS);
    expect(tickCount).toBe(3);
    expect(tree.blackboard.get('work')).toBe('finished');
    expect(tree.blackboard.get('completed')).toBe(true);
    // Tick 1: RUNNING, Tick 2: RUNNING, Tick 3: SUCCESS
    expect(tickCompleteEvents).toHaveLength(3);
  });

  it('Selector fallback with event tracing', async () => {
    const ctx = createContext();
    const enterEvents = collectEvents(ctx, 'node:enter');
    const exitEvents = collectEvents(ctx, 'node:exit');

    const selector = new SelectorNode({
      name: 'fallback-selector',
      children: [
        new ActionNode({
          name: 'primary',
          action: () => NodeStatus.FAILURE,
        }),
        new ActionNode({
          name: 'secondary',
          action: () => NodeStatus.FAILURE,
        }),
        new ActionNode(blackboardWriter('fallback', 'source', 'fallback')),
      ],
    });

    const status = await selector.tick(ctx);

    expect(status).toBe(NodeStatus.SUCCESS);
    expect(ctx.blackboard.get('source')).toBe('fallback');

    // Verify traversal order via enter events
    const enterNames = enterEvents.map((e) => e.node.name);
    expect(enterNames).toEqual(['fallback-selector', 'primary', 'secondary', 'fallback']);

    // Verify exit events match (children exit before parent)
    const exitNames = exitEvents.map((e) => e.node.name);
    expect(exitNames).toEqual(['primary', 'secondary', 'fallback', 'fallback-selector']);

    // Verify statuses on exit
    const exitStatuses = exitEvents.map((e) => e.status);
    expect(exitStatuses).toEqual([
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
    const { status, blackboard } = await tree.run();

    expect(status).toBe(NodeStatus.SUCCESS);
    expect(blackboard['count']).toBe(2); // increment to 1, double to 2
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

    // First tick: fast=SUCCESS, medium=RUNNING, slow=RUNNING → RUNNING
    const status1 = await parallel.tick(ctx);
    expect(status1).toBe(NodeStatus.RUNNING);
    expect(ctx.blackboard.get('fast')).toBe(true);

    // Second tick: fast=SUCCESS, medium=SUCCESS, slow=RUNNING → RUNNING
    // (parallel re-ticks all children including already-succeeded ones)
    const status2 = await parallel.tick(ctx);
    expect(status2).toBe(NodeStatus.RUNNING);

    // Third tick: fast=SUCCESS, medium=SUCCESS, slow=SUCCESS → SUCCESS (3 >= 2)
    const status3 = await parallel.tick(ctx);
    expect(status3).toBe(NodeStatus.SUCCESS);
  });
});
