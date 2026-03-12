import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { ParallelNode } from '../composites/parallel.js';
import { RetryNode } from '../decorators/retry.js';
import { TreeScheduler } from '../scheduler/tree-scheduler.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { createContext, AbortTrackingNode } from './helpers.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => handler),
}));

import { AgentNode } from '../nodes/agent.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

const mockQuery = vi.mocked(query);

describe('Abort Signal Integration', () => {
  it('sequence resumes at RUNNING child after abort — second child is never reached', async () => {
    let secondChildTicks = 0;

    const first = new ActionNode({
      name: 'first',
      action: () => NodeStatus.RUNNING,
    });

    const second = new ActionNode({
      name: 'second',
      action: () => {
        secondChildTicks++;
        return NodeStatus.SUCCESS;
      },
    });

    const sequence = new SequenceNode({
      name: 'seq',
      children: [first, second],
    });

    const ctx = createContext();

    // First tick: first child returns RUNNING, sequence returns RUNNING
    const status1 = await sequence.tick(ctx);
    expect(status1).toBe(NodeStatus.RUNNING);
    expect(secondChildTicks).toBe(0);

    // Abort signals the children but doesn't prevent future ticks by itself.
    // The key test: after abort, the sequence still resumes at the RUNNING child (first),
    // not at second. Verify second never ticks across multiple ticks.
    sequence.abort();

    // Second tick still starts from first child (which still returns RUNNING)
    const status2 = await sequence.tick(ctx);
    expect(status2).toBe(NodeStatus.RUNNING);

    // Second child should never have been ticked
    expect(secondChildTicks).toBe(0);
  });

  it('aborts parallel — all children receive abort', async () => {
    const children = [
      new AbortTrackingNode('child-1'),
      new AbortTrackingNode('child-2'),
      new AbortTrackingNode('child-3'),
    ];

    const parallel = new ParallelNode({
      name: 'par',
      children,
    });

    const ctx = createContext();
    const status = await parallel.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);

    parallel.abort();

    for (const child of children) {
      expect(child.aborted).toBe(true);
    }
  });

  it('aborts through decorators — retry propagates abort to child', async () => {
    const tracker = new AbortTrackingNode('inner');

    const retry = new RetryNode({
      name: 'retry',
      child: tracker,
      maxAttempts: 5,
    });

    const ctx = createContext();

    // RetryNode: child returns RUNNING, retry returns RUNNING (not FAILURE, so no retry loop)
    const status = await retry.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);

    retry.abort();
    expect(tracker.aborted).toBe(true);
  });

  it('abort with scheduler — scheduler.stop() fires manual stop event', async () => {
    const tree = new BehaviorTree({
      name: 'scheduler-abort',
      root: new ActionNode({
        name: 'slow',
        action: () => NodeStatus.RUNNING,
      }),
    });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', delayMs: 10 },
    });

    const stopEvents: unknown[] = [];
    scheduler.events.on('scheduler:stop', (data) => stopEvents.push(data));

    // Start scheduler in background, stop after first tick
    const startPromise = scheduler.start();
    await new Promise((r) => setTimeout(r, 50));

    await scheduler.stop();
    await startPromise;

    expect(scheduler.isRunning).toBe(false);
    expect(stopEvents).toHaveLength(1);
    expect((stopEvents[0] as any).reason).toBe('manual');
  });

  it('BehaviorTree.abort() cancels AgentNode in-flight SDK call via context.signal', async () => {
    let capturedAbortController: AbortController | undefined;
    let resolveMessage!: () => void;

    mockQuery.mockImplementation(({ options }: any) => {
      capturedAbortController = options.abortController;
      return (async function* () {
        await new Promise<void>((resolve) => { resolveMessage = resolve; });
        yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
      })() as any;
    });

    const tree = new BehaviorTree({
      name: 'agent-abort-test',
      root: new AgentNode({ name: 'agent', prompt: 'Do work' }),
    });

    const tickPromise = tree.tick();

    // The SDK call is in-flight — abort the tree (not the node directly)
    tree.abort();
    expect(capturedAbortController!.signal.aborted).toBe(true);

    resolveMessage();
    await tickPromise;
  });

  it('AbortSignal in async actions — action respects ctx.signal', async () => {
    let loopIterations = 0;

    const tree = new BehaviorTree({
      name: 'signal-test',
      root: new ActionNode({
        name: 'signal-aware',
        action: async (ctx) => {
          // Simulate async work that checks the signal
          while (!ctx.signal?.aborted) {
            loopIterations++;
            await new Promise((r) => setTimeout(r, 10));
            if (loopIterations >= 10) break; // safety limit
          }
          return ctx.signal?.aborted ? NodeStatus.FAILURE : NodeStatus.SUCCESS;
        },
      }),
    });

    // Start tick in background, abort after short delay
    const tickPromise = tree.tick();
    await new Promise((r) => setTimeout(r, 35));
    tree.abort();

    const status = await tickPromise;
    expect(status).toBe(NodeStatus.FAILURE);
    expect(loopIterations).toBeGreaterThan(0);
    expect(loopIterations).toBeLessThan(10);
  });
});
