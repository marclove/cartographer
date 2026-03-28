import { describe, it, expect, vi } from 'vitest';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { ParallelNode } from '../composites/parallel.js';
import { AgentExecutionStrategy } from '../strategies/agent-execution.js';
import { AgentParallelStrategy } from '../strategies/agent-parallel.js';
import { AgentSelectionStrategy } from '../strategies/agent-selection.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { createContext, collectEvents } from './helpers.js';
import type { AgentMessage, AgentSendOptions } from '../agent/agent.js';
import { TestAgent } from '../agent/test-agent.js';

function createStrategyAgent(output: unknown): { agent: TestAgent; sendSpy: ReturnType<typeof vi.fn> } {
  const agent = new TestAgent({ name: 'strategy-agent' });
  agent.setMessages([
    { type: 'result', subtype: 'success', output },
  ]);
  const sendSpy = vi.fn();
  const origSend = agent.send.bind(agent);
  agent.send = async function*(prompt: string, options?: AgentSendOptions) {
    sendSpy(prompt, options);
    yield* origSend(prompt, options);
  };
  return { agent, sendSpy };
}

describe('Agent Strategies Integration', () => {
  it('AgentExecutionStrategy reorders sequence children', async () => {
    const { agent } = createStrategyAgent({
      ordering: ['c', 'a', 'b'],
      reasoning: 'test ordering',
    });

    const ctx = createContext({ order: [] as string[] });
    const strategyEvents = collectEvents(ctx, 'strategy:decision');

    const makeChild = (name: string) =>
      new ActionNode({
        name,
        action: (ctx) => {
          const order = ctx.blackboard.get<string[]>('order')!;
          order.push(name);
          ctx.blackboard.set('order', order);
          return NodeStatus.SUCCESS;
        },
      });

    const strategy = new AgentExecutionStrategy({
      prompt: 'Order these steps',
      agent,
    });

    const sequence = new SequenceNode({
      name: 'reordered-seq',
      children: [makeChild('a'), makeChild('b'), makeChild('c')],
      strategy,
    });

    // Sync actions resolve immediately. The async strategy is awaited on the
    // first tick, then all three sync children complete in that same tick.
    const status = await sequence.tick(ctx);

    expect(status).toBe(NodeStatus.SUCCESS);
    expect(ctx.blackboard.get('order')).toEqual(['c', 'a', 'b']);
    expect(strategyEvents).toHaveLength(1);
    expect(strategyEvents[0].strategy).toBe('agent-execution');
  });

  it('AgentParallelStrategy sets policy', async () => {
    const { agent } = createStrategyAgent({
      policy: { successCount: 1 },
      reasoning: 'only need one',
    });

    const ctx = createContext();
    const strategyEvents = collectEvents(ctx, 'strategy:decision');

    const parallel = new ParallelNode({
      name: 'policy-par',
      children: [
        new ActionNode({ name: 'fast', action: () => NodeStatus.SUCCESS }),
        new ActionNode({ name: 'slow-1', action: () => NodeStatus.FAILURE }),
        new ActionNode({ name: 'slow-2', action: () => NodeStatus.FAILURE }),
      ],
      strategy: new AgentParallelStrategy({
        prompt: 'Set the policy',
        agent,
      }),
    });

    // Sync actions resolve immediately. The async strategy is awaited on the
    // first tick, then all sync children complete in that same tick.
    // Policy: successCount(1), fast is SUCCESS → policy met → SUCCESS.
    const status = await parallel.tick(ctx);

    expect(status).toBe(NodeStatus.SUCCESS);
    expect(strategyEvents).toHaveLength(1);
    expect(strategyEvents[0].strategy).toBe('agent-parallel');
  });

  it('strategy caching — agent.send() called once for two order() calls', async () => {
    const { agent, sendSpy } = createStrategyAgent({
      ordering: ['a', 'b'],
      reasoning: 'default',
    });

    const strategy = new AgentSelectionStrategy({
      prompt: 'Order these',
      agent,
      cache: true,
    });

    const children = [
      new ActionNode({ name: 'a', action: () => NodeStatus.SUCCESS }),
      new ActionNode({ name: 'b', action: () => NodeStatus.SUCCESS }),
    ];

    const ctx = createContext();

    await strategy.order(children, ctx);
    await strategy.order(children, ctx);

    expect(sendSpy).toHaveBeenCalledOnce();
  });

  it('strategy reset clears cache — agent.send() called twice', async () => {
    const { agent, sendSpy } = createStrategyAgent({
      ordering: ['a', 'b'],
      reasoning: 'default',
    });

    const strategy = new AgentSelectionStrategy({
      prompt: 'Order these',
      agent,
      cache: true,
    });

    const children = [
      new ActionNode({ name: 'a', action: () => NodeStatus.SUCCESS }),
      new ActionNode({ name: 'b', action: () => NodeStatus.SUCCESS }),
    ];

    const ctx = createContext();

    await strategy.order(children, ctx);
    strategy.reset();
    await strategy.order(children, ctx);

    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('BehaviorTree.abort() propagates signal through agent.send()', async () => {
    let capturedSignal: AbortSignal | undefined;

    const agent = new TestAgent({ name: 'blocking-agent' });
    let resolveQuery!: () => void;
    agent.send = async function*(_prompt: string, options?: AgentSendOptions) {
      capturedSignal = options?.signal;
      await new Promise<void>((resolve) => { resolveQuery = resolve; });
      yield { type: 'result', subtype: 'success', output: { ordering: ['a', 'b'], reasoning: 'default' } } as AgentMessage;
    };

    const tree = new BehaviorTree({
      name: 'strategy-abort-test',
      root: new SequenceNode({
        name: 'signal-seq',
        children: [
          new ActionNode({ name: 'a', action: () => NodeStatus.SUCCESS }),
          new ActionNode({ name: 'b', action: () => NodeStatus.SUCCESS }),
        ],
        strategy: new AgentExecutionStrategy({ prompt: 'Order', agent }),
      }),
    });

    const tickPromise = tree.tick();

    // Strategy is blocked in agent.send() — abort the tree
    tree.abort();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(true);

    resolveQuery();
    await tickPromise;
  });
});
