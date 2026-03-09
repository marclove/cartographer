import { describe, it, expect } from 'vitest';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { ParallelNode } from '../composites/parallel.js';
import { AgentParallelStrategy } from '../strategies/agent-parallel.js';
import { createContext, collectEvents } from './helpers.js';

// --- Live API test ---
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!HAS_KEY)('Agent Strategies Integration (Live API)', { timeout: 30_000 }, () => {
  it('AgentParallelStrategy end-to-end with live API', async () => {
    const ctx = createContext();
    const strategyEvents = collectEvents(ctx, 'strategy:decision');

    const strategy = new AgentParallelStrategy({
      prompt: 'Choose a policy that requires at least 2 successes out of 3 children.',
      model: 'haiku',
      effort: 'low',
    });

    const children = [
      new ActionNode({ name: 'task-a', action: () => NodeStatus.SUCCESS }),
      new ActionNode({ name: 'task-b', action: () => NodeStatus.SUCCESS }),
      new ActionNode({ name: 'task-c', action: () => NodeStatus.SUCCESS }),
    ];

    const parallel = new ParallelNode({
      name: 'live-par',
      children,
      strategy,
    });

    const status = await parallel.tick(ctx);

    expect(status).toBe(NodeStatus.SUCCESS);
    expect(strategyEvents).toHaveLength(1);

    const decision = strategyEvents[0].decision as any;
    expect(decision.policy).toBeDefined();
    expect(typeof decision.reasoning).toBe('string');
  });
});
