import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { ParallelNode } from '../composites/parallel.js';
import { AgentExecutionStrategy } from '../strategies/agent-execution.js';
import { AgentParallelStrategy } from '../strategies/agent-parallel.js';
import { AgentSelectionStrategy } from '../strategies/agent-selection.js';
import { createContext, collectEvents } from './helpers.js';
import { queryStructured } from '../agent/sdk-helpers.js';

vi.mock('../agent/sdk-helpers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../agent/sdk-helpers.js')>();
  return {
    ...original,
    queryStructured: vi.fn(),
  };
});

const mockedQueryStructured = vi.mocked(queryStructured);

describe('Agent Strategies Integration (Mocked SDK)', () => {
  beforeEach(() => {
    mockedQueryStructured.mockReset();
  });

  it('AgentExecutionStrategy reorders sequence children', async () => {
    mockedQueryStructured.mockResolvedValue({
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
      model: 'haiku',
    });

    const sequence = new SequenceNode({
      name: 'reordered-seq',
      children: [makeChild('a'), makeChild('b'), makeChild('c')],
      strategy,
    });

    const status = await sequence.tick(ctx);

    expect(status).toBe(NodeStatus.SUCCESS);
    expect(ctx.blackboard.get('order')).toEqual(['c', 'a', 'b']);
    expect(strategyEvents).toHaveLength(1);
    expect(strategyEvents[0].strategy).toBe('agent-execution');
    expect(mockedQueryStructured).toHaveBeenCalledOnce();
  });

  it('AgentParallelStrategy sets policy', async () => {
    mockedQueryStructured.mockResolvedValue({
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
        model: 'haiku',
      }),
    });

    // With successCount: 1 and 1 SUCCESS child (no RUNNING children), parallel should return SUCCESS
    const status = await parallel.tick(ctx);

    expect(status).toBe(NodeStatus.SUCCESS);
    expect(strategyEvents).toHaveLength(1);
    expect(strategyEvents[0].strategy).toBe('agent-parallel');
    expect(mockedQueryStructured).toHaveBeenCalledOnce();
  });

  it('strategy caching — SDK called once for two order() calls', async () => {
    mockedQueryStructured.mockResolvedValue({
      ordering: ['a', 'b'],
      reasoning: 'default',
    });

    const strategy = new AgentSelectionStrategy({
      prompt: 'Order these',
      model: 'haiku',
      cache: true,
    });

    const children = [
      new ActionNode({ name: 'a', action: () => NodeStatus.SUCCESS }),
      new ActionNode({ name: 'b', action: () => NodeStatus.SUCCESS }),
    ];

    const ctx = createContext();

    await strategy.order(children, ctx);
    await strategy.order(children, ctx);

    expect(mockedQueryStructured).toHaveBeenCalledOnce();
  });

  it('strategy reset clears cache — SDK called twice', async () => {
    mockedQueryStructured.mockResolvedValue({
      ordering: ['a', 'b'],
      reasoning: 'default',
    });

    const strategy = new AgentSelectionStrategy({
      prompt: 'Order these',
      model: 'haiku',
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

    expect(mockedQueryStructured).toHaveBeenCalledTimes(2);
  });
});
