import { z } from 'zod/v4';
import type { ExecutionStrategy, BTreeNode, TreeContext, AgentStrategyConfig } from '../types.js';
import { queryStructured, buildStrategyPrompt, createStrategyMessageHandler, wrapElicitation } from '../agent/sdk-helpers.js';

/**
 * The schema Claude must conform to when returning an ordering decision.
 * `ordering` is a list of child node names in the desired execution order.
 * `reasoning` is a brief explanation logged via the `strategy:decision` event.
 */
const OrderingSchema = z.object({
  ordering: z.array(z.string()).describe('Child node names in execution order'),
  reasoning: z.string().describe('Brief explanation of the ordering decision'),
});

/**
 * An {@link ExecutionStrategy} that asks Claude to decide the order in which
 * a {@link SequenceNode} executes its children.
 *
 * The composite calls this strategy once per execution cycle (the order is
 * committed for the cycle's duration). When `cache: true`, the decision
 * persists across cycles until `reset()` is called. Claude receives a prompt
 * that includes the child node names, any descriptions supplied via
 * `childDescriptions`, and a JSON snapshot of the current blackboard. Claude
 * returns an ordered list of child names, which is mapped back to node
 * references and returned to the sequence.
 *
 * **Important ordering semantics:**
 * - Children are matched by name. Only children whose names appear in
 *   Claude's response are included in the reordered result. Any child
 *   whose name is omitted will **not** be executed during that tick.
 * - If the SDK call fails or Claude returns no recognisable names, the
 *   strategy falls back to the original child order so the sequence
 *   can still make progress.
 * - A `strategy:decision` event is emitted after each successful SDK call,
 *   carrying Claude's `ordering` array and `reasoning` string.
 *
 * **Basic usage with a SequenceNode:**
 * ```ts
 * const pipeline = new SequenceNode({
 *   name: 'data-pipeline',
 *   children: [fetchData, transformData, validateData, storeData],
 *   strategy: new AgentExecutionStrategy({
 *     prompt: 'Order these steps for the most efficient data processing pipeline',
 *     childDescriptions: {
 *       fetchData:      'Retrieves raw records from the upstream API',
 *       transformData:  'Normalises and enriches the records',
 *       validateData:   'Checks integrity and business rules',
 *       storeData:      'Persists the processed records to the database',
 *     },
 *   }),
 * });
 * ```
 *
 * **Dynamic prompt with blackboard access:**
 * ```ts
 * const adaptive = new SequenceNode({
 *   name: 'adaptive-sequence',
 *   children: [stepA, stepB, stepC],
 *   strategy: new AgentExecutionStrategy({
 *     prompt: (children, context) => {
 *       const mode = context.blackboard.get<string>('mode');
 *       return `Order these steps for ${mode} mode execution`;
 *     },
 *     options: { model: 'claude-haiku-4-5-20251001', effort: 'low' },
 *   }),
 * });
 * ```
 *
 * **Caching the decision across execution cycles:**
 * ```ts
 * // Without cache, Claude is consulted at the start of each execution cycle.
 * // With cache: true, the first decision is reused across cycles until reset().
 * const cached = new SequenceNode({
 *   name: 'cached-sequence',
 *   children: [stepA, stepB, stepC],
 *   strategy: new AgentExecutionStrategy({
 *     prompt: 'Determine the optimal step order',
 *     cache: true,
 *   }),
 * });
 * ```
 *
 * **Observing decisions:**
 * ```ts
 * tree.events.on('strategy:decision', ({ strategy, decision }) => {
 *   if (strategy === 'agent-execution') {
 *     const { ordering, reasoning } = decision as { ordering: string[]; reasoning: string };
 *     console.log('Execution order:', ordering.join(' → '));
 *     console.log('Reasoning:', reasoning);
 *   }
 * });
 * ```
 */
export class AgentExecutionStrategy implements ExecutionStrategy {
  /**
   * Cached result from a previous `order()` call.
   * `null` when caching is disabled or `reset()` has been called.
   */
  private cachedOrder: BTreeNode[] | null = null;

  constructor(private config: AgentStrategyConfig) {}

  /**
   * Clear the cached ordering so the next tick calls the SDK again.
   *
   * Only has an effect when `cache: true` was set in the config.
   */
  reset(): void {
    this.cachedOrder = null;
  }

  /**
   * Return the children in the order Claude recommends for this tick.
   *
   * Builds a prompt from the config and current blackboard state, calls the
   * SDK, and maps the returned names back to node references. Falls back to
   * the original `children` array if the SDK call fails or returns no
   * recognisable child names.
   *
   * Elicitation is handled consistently with `AgentNode`: the handler is
   * resolved as `config.options.onElicitation ?? context.onElicitation`,
   * wrapped via {@link wrapElicitation}, and forwarded to the SDK. If no
   * handler exists, elicitation requests are declined and an
   * `agent:elicitation_declined` event is emitted.
   */
  async order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]> {
    if (this.config.cache && this.cachedOrder !== null) {
      return this.cachedOrder;
    }

    const prompt = buildStrategyPrompt(this.config, children, context);
    const nodeProxy = children[0] ?? ({ id: '', name: '' } as any);
    context.events.emit('agent:prompt', { node: nodeProxy, prompt });

    const handler = createStrategyMessageHandler(nodeProxy, context.events);
    const elicitationHandler = this.config.options?.onElicitation ?? context.onElicitation;
    const wrappedElicitation = wrapElicitation(elicitationHandler, nodeProxy, context.events);
    const result = await queryStructured(prompt, OrderingSchema, this.config, handler, context.signal, wrappedElicitation);

    // SDK call failed — fall back to original order so the sequence can proceed.
    if (!result) {
      return children;
    }

    context.events.emit('strategy:decision', {
      // The strategy doesn't have a reference to the parent composite node,
      // so the first child is used as a proxy identifier in the event payload.
      composite: children[0] ?? ({ id: '', name: '' } as any),
      strategy: 'agent-execution',
      decision: result,
    });

    // Map Claude's ordered name list back to node references.
    // Children whose names are not present in the response are dropped.
    const nameToChild = new Map(children.map((c) => [c.name, c]));
    const reordered = result.ordering
      .map((name: string) => nameToChild.get(name))
      .filter((c): c is BTreeNode => c !== undefined);

    // Claude returned no recognisable names — fall back to original order.
    if (reordered.length === 0) {
      if (this.config.cache) this.cachedOrder = children;
      return children;
    }

    if (this.config.cache) this.cachedOrder = reordered;
    return reordered;
  }
}
