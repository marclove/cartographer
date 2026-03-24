import { z } from 'zod/v4';
import type { SelectionStrategy, BTreeNode, TreeContext, AgentStrategyConfig } from '../types.js';
import { buildStrategyPrompt, wrapElicitation } from '../agent/sdk-helpers.js';
import type { AgentMessage } from '../agent/agent.js';

/**
 * The schema the agent must conform to when returning an ordering decision.
 * `ordering` is a list of child node names in the desired try-first order.
 * `reasoning` is a brief explanation logged via the `strategy:decision` event.
 */
const OrderingSchema = z.object({
  ordering: z.array(z.string()).describe('Child node names in the order they should be tried'),
  reasoning: z.string().describe('Brief explanation of the ordering decision'),
});

/**
 * A {@link SelectionStrategy} that asks an Agent to decide which children a
 * {@link SelectorNode} should try first.
 *
 * The composite calls this strategy once per execution cycle (the order is
 * committed for the cycle's duration). When `cache: true`, the decision
 * persists across cycles until `reset()` is called. The agent receives a
 * prompt that includes the child node names, any descriptions supplied via
 * `childDescriptions`, and a JSON snapshot of the current blackboard. The
 * agent returns an ordered list of child names — the selector will try them
 * in that order, stopping at the first `SUCCESS`.
 *
 * **Important ordering semantics:**
 * - Children are matched by name. Only children whose names appear in
 *   the agent's response are included in the reordered result. Any child
 *   whose name is omitted will **not** be attempted during that tick.
 * - If the agent call fails or returns no recognisable names, the strategy
 *   falls back to the original child order so the selector can still
 *   make progress.
 * - A `strategy:decision` event is emitted after each successful call,
 *   carrying the `ordering` array and `reasoning` string.
 */
export class AgentSelectionStrategy implements SelectionStrategy {
  /**
   * Cached result from a previous `order()` call.
   * `null` when caching is disabled or `reset()` has been called.
   */
  private cachedOrder: BTreeNode[] | null = null;

  constructor(private config: AgentStrategyConfig) {}

  /**
   * Clear the cached ordering so the next tick calls the agent again.
   */
  reset(): void {
    this.cachedOrder = null;
  }

  /**
   * Return the children in the order the agent recommends trying for this tick.
   */
  async order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]> {
    if (this.config.cache && this.cachedOrder !== null) {
      return this.cachedOrder;
    }

    const prompt = buildStrategyPrompt(this.config, children, context);
    const nodeProxy = children[0] ?? ({ id: '', name: '' } as any);
    context.events.emit('agent:prompt', { node: nodeProxy, prompt });

    const { $schema, ...jsonSchema } = z.toJSONSchema(OrderingSchema) as Record<string, unknown>;

    let result: z.infer<typeof OrderingSchema> | null = null;

    try {
      for await (const msg of this.config.agent.send(prompt, {
        signal: context.signal,
        onMessage: (msg: AgentMessage) => this.emitAgentEvent(msg, nodeProxy, context),
        outputSchema: jsonSchema,
        onElicitation: wrapElicitation(context.onElicitation, nodeProxy, context.events),
      })) {
        if (msg.type === 'result') {
          if (msg.subtype === 'success') {
            result = msg.output as z.infer<typeof OrderingSchema>;
          }
        }
      }
    } catch {
      // Agent threw — fall back to original order.
      return children;
    }

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
      if (this.config.cache) this.cachedOrder = children;
      return children;
    }

    if (this.config.cache) this.cachedOrder = reordered;
    return reordered;
  }

  private emitAgentEvent(msg: AgentMessage, node: BTreeNode, context: TreeContext): void {
    switch (msg.type) {
      case 'thinking':
        context.events.emit('agent:thinking', { node, thinking: msg.content });
        break;
      case 'text':
        context.events.emit('agent:text', { node, text: msg.content });
        break;
      case 'tool_use':
        context.events.emit('agent:tool_use', { node, tool: msg.name, input: msg.input });
        break;
      case 'stream':
        context.events.emit('agent:stream', { node, event: msg.event });
        break;
      case 'result':
        if (msg.subtype === 'success') {
          context.events.emit('agent:response', { node, result: msg.output, cost: msg.cost });
        } else {
          (context.events.emit as any)('agent:error', { node, errors: msg.errors, cost: msg.cost });
        }
        break;
      case 'provider_event': {
        const d = msg.data as Record<string, unknown>;
        const eventMap: Record<string, string> = { tool_progress: 'agent:tool_progress', init: 'agent:init', status: 'agent:status', rate_limit: 'agent:rate_limit' };
        const eventName = eventMap[msg.subtype];
        if (eventName) (context.events.emit as any)(eventName, { node, ...d });
        break;
      }
    }
  }
}
