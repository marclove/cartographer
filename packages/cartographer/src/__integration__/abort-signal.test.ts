import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { ParallelNode } from '../composites/parallel.js';
import { Retry } from '../decorators/retry.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { createContext, AbortTrackingNode } from './helpers.js';
import { AgentNode } from '../nodes/agent.js';
import type { AgentMessage, AgentSendOptions } from '../agent/agent.js';
import { TestAgent } from '../agent/test-agent.js';

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

    const retry = new Retry({
      name: 'retry',
      child: tracker,
      maxAttempts: 5,
    });

    const ctx = createContext();

    // Retry: child returns RUNNING, retry returns RUNNING (not FAILURE, so no retry loop)
    const status = await retry.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);

    retry.abort();
    expect(tracker.aborted).toBe(true);
  });

  it('BehaviorTree.abort() cancels AgentNode in-flight SDK call via context.signal', async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveMessage!: () => void;

    const agent = new TestAgent({ name: 'agent' });
    // Override send to capture the signal and block until resolved
    agent.send = async function* (_prompt: string, options?: AgentSendOptions) {
      capturedSignal = options?.signal;
      await new Promise<void>((resolve) => { resolveMessage = resolve; });
      yield { type: 'result', subtype: 'success', output: 'done', cost: 0.01 } as AgentMessage;
    };

    const tree = new BehaviorTree({
      name: 'agent-abort-test',
      root: new AgentNode<unknown>({ name: 'agent', agent, prompt: 'Do work' }),
    });

    const tickPromise = tree.tick();

    // The SDK call is in-flight — abort the tree (not the node directly)
    tree.abort();
    expect(capturedSignal!.aborted).toBe(true);

    resolveMessage();
    await tickPromise;
  });

  it('AbortSignal in async actions — action respects ctx.signal', async () => {
    const flush = () => new Promise<void>(r => setTimeout(r, 0));
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

    // First tick: action starts inflight, returns RUNNING immediately
    const status1 = await tree.tick();
    expect(status1).toBe(NodeStatus.RUNNING);

    // Abort after short delay — clears inflight state and aborts the signal
    await new Promise((r) => setTimeout(r, 35));
    tree.abort();

    // Wait for the underlying action promise to settle (it checks signal on next loop)
    await new Promise((r) => setTimeout(r, 20));
    await flush();

    // Second tick: re-invokes action with already-aborted signal, action exits immediately → RUNNING (inflight)
    await tree.tick();
    await flush();
    // Third tick: inflight result (FAILURE) is now available
    const status3 = await tree.tick();
    expect(status3).toBe(NodeStatus.FAILURE);
    expect(loopIterations).toBeGreaterThan(0);
    expect(loopIterations).toBeLessThan(10);
  });
});
