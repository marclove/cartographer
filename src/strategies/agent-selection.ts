import { z } from 'zod/v4';
import type { SelectionStrategy, BTreeNode, TreeContext, AgentStrategyConfig } from '../types.js';
import { queryStructured, buildStrategyPrompt } from '../agent/sdk-helpers.js';

const OrderingSchema = z.object({
  ordering: z.array(z.string()).describe('Child node names in the order they should be tried'),
  reasoning: z.string().describe('Brief explanation of the ordering decision'),
});

export class AgentSelectionStrategy implements SelectionStrategy {
  constructor(private config: AgentStrategyConfig) {}

  async order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]> {
    const prompt = buildStrategyPrompt(this.config, children, context);
    const result = await queryStructured(prompt, OrderingSchema, this.config);

    if (!result) {
      return children;
    }

    context.events.emit('strategy:decision', {
      composite: children[0] ?? ({ id: '', name: '' } as any),
      strategy: 'agent-selection',
      decision: result,
    });

    const nameToChild = new Map(children.map((c) => [c.name, c]));
    const reordered = result.ordering
      .map((name: string) => nameToChild.get(name))
      .filter((c): c is BTreeNode => c !== undefined);

    if (reordered.length === 0) {
      return children;
    }

    return reordered;
  }
}
