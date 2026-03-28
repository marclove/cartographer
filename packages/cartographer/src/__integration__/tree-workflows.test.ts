import { describe, it, expect } from 'vitest';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { ParallelNode } from '../composites/parallel.js';
import { Retry } from '../decorators/retry.js';
import { Timeout } from '../decorators/timeout.js';
import { TreeBuilder } from '../builder/tree-builder.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';
import {
  createContext,
  sequentialAction,
  blackboardWriter,
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

    const timeout = new Timeout({
      name: 'timeout-wrapper',
      child: unreliable,
      timeoutMs: 100,
    });

    const retry = new Retry({
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

  it('RUNNING resumption across multiple ticks', async () => {
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

    let totalTicks = 0;
    let status = await tree.tick();
    totalTicks++;
    while (status === NodeStatus.RUNNING) {
      await flush();
      status = await tree.tick();
      totalTicks++;
    }

    expect(status).toBe(NodeStatus.SUCCESS);
    expect(tickCount).toBe(3);
    expect(tree.blackboard.get('work')).toBe('finished');
    expect(tree.blackboard.get('completed')).toBe(true);
    // Sync actions (guard-check, completion) resolve in a single tick.
    // multi-tick returns RUNNING twice then SUCCESS, so it takes 3 ticks.
    // Total: 3 ticks (guard resolves instantly within each tick,
    // multi-tick drives the RUNNING loop, completion resolves instantly).
    expect(totalTicks).toBe(3);
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

    // Single tick: primary (FAILURE), secondary (FAILURE), fallback is sync → SUCCESS
    const status1 = await selector.tick(ctx);
    expect(status1).toBe(NodeStatus.SUCCESS);
    expect(ctx.blackboard.get('source')).toBe('fallback');

    // All nodes entered and exited in a single tick:
    //   fallback-selector, primary, secondary, fallback
    const enterNames = enterEvents.map((e) => e.node.name);
    expect(enterNames).toEqual([
      'fallback-selector', 'primary', 'secondary', 'fallback',
    ]);

    // Exit events (children exit before parent):
    //   primary, secondary, fallback, fallback-selector
    const exitNames = exitEvents.map((e) => e.node.name);
    expect(exitNames).toEqual([
      'primary', 'secondary', 'fallback', 'fallback-selector',
    ]);

    // Statuses: FAILURE, FAILURE, SUCCESS, SUCCESS
    const exitStatuses = exitEvents.map((e) => e.status);
    expect(exitStatuses).toEqual([
      NodeStatus.FAILURE,
      NodeStatus.FAILURE,
      NodeStatus.SUCCESS,
      NodeStatus.SUCCESS,
    ]);
  });

  it('Parallel with RUNNING children and successCount policy', async () => {
    let fastTicks = 0;

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

    // With the sync fast path, sync actions return their result in a
    // single tick. The sequentialAction helper returns sync values.
    //
    // Logical sequence:
    //   Tick 1: fast → SUCCESS (sync), medium → RUNNING (sync),
    //           slow → RUNNING (sync) → parallel RUNNING
    //   Tick 2: fast cached; medium → SUCCESS (sync, 2nd call);
    //           slow → RUNNING (sync, 2nd call)
    //           → policy: 2 successes ≥ successCount(2) → SUCCESS
    //           (slow is aborted)

    // Tick 1 – fast resolves immediately, medium/slow return RUNNING
    const status1 = await parallel.tick(ctx);
    expect(status1).toBe(NodeStatus.RUNNING);
    expect(ctx.blackboard.get('fast')).toBe(true);

    // Tick 2 – medium resolves SUCCESS; successCount(2) met → SUCCESS
    const status2 = await parallel.tick(ctx);
    expect(status2).toBe(NodeStatus.SUCCESS);
  });
});
