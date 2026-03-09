import { z } from 'zod/v4';
import type { ParallelStrategy, ParallelPolicy, BTreeNode, TreeContext, AgentStrategyConfig } from '../types.js';
import { queryStructured, buildStrategyPrompt } from '../agent/sdk-helpers.js';

const PolicySchema = z.object({
  policy: z.object({
    successCount: z.number().optional(),
    successPercentage: z.number().optional(),
    failureCount: z.number().optional(),
  }).describe('The parallel execution policy'),
  reasoning: z.string().describe('Brief explanation of the policy decision'),
});

export class AgentParallelStrategy implements ParallelStrategy {
  constructor(private config: AgentStrategyConfig) {}

  async policy(children: BTreeNode[], context: TreeContext): Promise<ParallelPolicy> {
    const prompt = buildStrategyPrompt(this.config, children, context);
    const result = await queryStructured(prompt, PolicySchema, this.config);

    if (!result) {
      return { successCount: children.length };
    }

    context.events.emit('strategy:decision', {
      composite: children[0] ?? ({ id: '', name: '' } as any),
      strategy: 'agent-parallel',
      decision: result,
    });

    return result.policy;
  }
}
