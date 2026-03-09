import { z } from 'zod/v4';
import type { ExecutionStrategy, BTreeNode, TreeContext, AgentStrategyConfig } from '../types.js';
import { queryStructured, buildStrategyPrompt } from '../agent/sdk-helpers.js';

const OrderingSchema = z.object({
  ordering: z.array(z.string()).describe('Child node names in execution order'),
  reasoning: z.string().describe('Brief explanation of the ordering decision'),
});

export class AgentExecutionStrategy implements ExecutionStrategy {
  private cachedOrder: BTreeNode[] | null = null;

  constructor(private config: AgentStrategyConfig) {}

  reset(): void {
    this.cachedOrder = null;
  }

  async order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]> {
    if (this.config.cache && this.cachedOrder !== null) {
      return this.cachedOrder;
    }

    const prompt = buildStrategyPrompt(this.config, children, context);
    const result = await queryStructured(prompt, OrderingSchema, this.config);

    if (!result) {
      return children;
    }

    context.events.emit('strategy:decision', {
      composite: children[0] ?? ({ id: '', name: '' } as any),
      strategy: 'agent-execution',
      decision: result,
    });

    const nameToChild = new Map(children.map((c) => [c.name, c]));
    const reordered = result.ordering
      .map((name: string) => nameToChild.get(name))
      .filter((c): c is BTreeNode => c !== undefined);

    if (reordered.length === 0) {
      if (this.config.cache) this.cachedOrder = children;
      return children;
    }

    if (this.config.cache) this.cachedOrder = reordered;
    return reordered;
  }
}
