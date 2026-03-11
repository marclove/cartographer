import { z } from 'zod/v4';
import type { SelectionStrategy, BTreeNode, TreeContext, AgentStrategyConfig } from '../types.js';
import { queryStructured, buildStrategyPrompt, createStrategyMessageHandler } from '../agent/sdk-helpers.js';

/**
 * The schema Claude must conform to when returning an ordering decision.
 * `ordering` is a list of child node names in the desired try-first order.
 * `reasoning` is a brief explanation logged via the `strategy:decision` event.
 */
const OrderingSchema = z.object({
  ordering: z.array(z.string()).describe('Child node names in the order they should be tried'),
  reasoning: z.string().describe('Brief explanation of the ordering decision'),
});

/**
 * A {@link SelectionStrategy} that asks Claude to decide which children a
 * {@link SelectorNode} should try first.
 *
 * The composite calls this strategy once per execution cycle (the order is
 * committed for the cycle's duration). When `cache: true`, the decision
 * persists across cycles until `reset()` is called. Claude receives a prompt
 * that includes the child node names, any descriptions supplied via
 * `childDescriptions`, and a JSON snapshot of the current blackboard. Claude
 * returns an ordered list of child names — the selector will try them in that
 * order, stopping at the first `SUCCESS`.
 *
 * This is distinct from {@link AgentExecutionStrategy}: a selection strategy
 * controls *which option to attempt first* in a fallback chain, while an
 * execution strategy controls *in what order to run steps* in a pipeline. Use
 * this strategy when the children represent alternative paths to the same
 * goal and Claude should pick the most promising one based on context.
 *
 * **Important ordering semantics:**
 * - Children are matched by name. Only children whose names appear in
 *   Claude's response are included in the reordered result. Any child
 *   whose name is omitted will **not** be attempted during that tick.
 * - If the SDK call fails or Claude returns no recognisable names, the
 *   strategy falls back to the original child order so the selector can
 *   still make progress.
 * - A `strategy:decision` event is emitted after each successful SDK call,
 *   carrying Claude's `ordering` array and `reasoning` string.
 *
 * **Context-aware fallback prioritisation:**
 * ```ts
 * // Claude reads the blackboard to decide whether to try the cache or the
 * // API first based on the current latency budget.
 * const getUser = new SelectorNode({
 *   name: 'get-user',
 *   children: [fromCache, fromDatabase, fromArchive],
 *   strategy: new AgentSelectionStrategy({
 *     prompt: 'Choose the best data source given the latency budget on the blackboard',
 *     childDescriptions: {
 *       fromCache:    'Returns cached data instantly; may be stale',
 *       fromDatabase: 'Queries the live database; ~50ms',
 *       fromArchive:  'Fetches from cold storage; ~2s',
 *     },
 *   }),
 * });
 * ```
 *
 * **Dynamic prompt with blackboard access:**
 * ```ts
 * const adaptive = new SelectorNode({
 *   name: 'adaptive-selector',
 *   children: [quickReply, deepResearch, fallbackResponse],
 *   strategy: new AgentSelectionStrategy({
 *     prompt: (children, context) => {
 *       const intent = context.blackboard.get<string>('intent');
 *       return `For a "${intent}" request, choose which response strategy to try first`;
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
 * const cached = new SelectorNode({
 *   name: 'cached-selector',
 *   children: [optionA, optionB, optionC],
 *   strategy: new AgentSelectionStrategy({
 *     prompt: 'Rank these options by likelihood of success',
 *     cache: true,
 *   }),
 * });
 * ```
 *
 * **Observing decisions:**
 * ```ts
 * tree.events.on('strategy:decision', ({ strategy, decision }) => {
 *   if (strategy === 'agent-selection') {
 *     const { ordering, reasoning } = decision as { ordering: string[]; reasoning: string };
 *     console.log('Try order:', ordering.join(' → '));
 *     console.log('Reasoning:', reasoning);
 *   }
 * });
 * ```
 */
export class AgentSelectionStrategy implements SelectionStrategy {
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
   * Return the children in the order Claude recommends trying for this tick.
   *
   * Builds a prompt from the config and current blackboard state, calls the
   * SDK, and maps the returned names back to node references. Falls back to
   * the original `children` array if the SDK call fails or returns no
   * recognisable child names.
   */
  async order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]> {
    if (this.config.cache && this.cachedOrder !== null) {
      return this.cachedOrder;
    }

    const prompt = buildStrategyPrompt(this.config, children, context);
    const nodeProxy = children[0] ?? ({ id: '', name: '' } as any);
    context.events.emit('agent:prompt', { node: nodeProxy, prompt });

    const handler = createStrategyMessageHandler(nodeProxy, context.events);
    const result = await queryStructured(prompt, OrderingSchema, this.config, handler, context.signal);

    // SDK call failed — fall back to original order so the selector can proceed.
    if (!result) {
      return children;
    }

    context.events.emit('strategy:decision', {
      // The strategy doesn't have a reference to the parent composite node,
      // so the first child is used as a proxy identifier in the event payload.
      composite: children[0] ?? ({ id: '', name: '' } as any),
      strategy: 'agent-selection',
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
