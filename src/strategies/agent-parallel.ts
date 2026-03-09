import { z } from 'zod/v4';
import type { ParallelStrategy, ParallelPolicy, BTreeNode, TreeContext, AgentStrategyConfig } from '../types.js';
import { queryStructured, buildStrategyPrompt } from '../agent/sdk-helpers.js';

/**
 * The schema Claude must conform to when returning a policy decision.
 * `policy` maps to the {@link ParallelPolicy} fields the `ParallelNode` evaluates.
 * `reasoning` is a brief explanation logged via the `strategy:decision` event.
 */
const PolicySchema = z.object({
  policy: z.object({
    successCount: z.number().optional(),
    successPercentage: z.number().optional(),
    failureCount: z.number().optional(),
  }).describe('The parallel execution policy'),
  reasoning: z.string().describe('Brief explanation of the policy decision'),
});

/**
 * A {@link ParallelStrategy} that asks Claude to decide the success/failure
 * policy for a {@link ParallelNode} at runtime.
 *
 * On each tick (or once per reset cycle when `cache: true`), Claude receives
 * a prompt that includes the child node names, any descriptions supplied via
 * `childDescriptions`, and a JSON snapshot of the current blackboard. Claude
 * returns a {@link ParallelPolicy} specifying how many children must succeed
 * (or fail) for the parallel node to resolve.
 *
 * If the SDK call fails, the strategy falls back to the safest default:
 * requiring *all* children to succeed (`{ successCount: children.length }`).
 *
 * **Risk-adaptive policy:**
 * ```ts
 * // The blackboard holds 'riskLevel': 'low' | 'medium' | 'high'.
 * // Claude uses it to decide whether a simple majority or unanimity is needed.
 * const checks = new ParallelNode({
 *   name: 'validation-checks',
 *   children: [checkSchema, checkAuth, checkRateLimit, checkQuota],
 *   strategy: new AgentParallelStrategy({
 *     prompt: 'Decide how many validations must pass given the current risk level on the blackboard',
 *     childDescriptions: {
 *       checkSchema:    'Validates the request payload structure',
 *       checkAuth:      'Verifies authentication credentials',
 *       checkRateLimit: 'Enforces per-user rate limits',
 *       checkQuota:     'Checks account usage quotas',
 *     },
 *   }),
 * });
 * ```
 *
 * **Dynamic prompt with blackboard access:**
 * ```ts
 * const dynamic = new ParallelNode({
 *   name: 'dynamic-parallel',
 *   children: [nodeA, nodeB, nodeC],
 *   strategy: new AgentParallelStrategy({
 *     prompt: (children, context) => {
 *       const env = context.blackboard.get<string>('environment');
 *       return `In ${env} environment, decide the minimum success threshold for these checks`;
 *     },
 *     model: 'haiku',
 *     effort: 'low',
 *   }),
 * });
 * ```
 *
 * **Caching the policy across ticks:**
 * ```ts
 * // Claude is called only on the first tick after construction or reset().
 * // Subsequent ticks reuse the same policy without an SDK call.
 * const cached = new ParallelNode({
 *   name: 'cached-parallel',
 *   children: [nodeA, nodeB, nodeC],
 *   strategy: new AgentParallelStrategy({
 *     prompt: 'Decide the success threshold for this run',
 *     cache: true,
 *   }),
 * });
 * ```
 *
 * **Observing decisions:**
 * ```ts
 * tree.events.on('strategy:decision', ({ strategy, decision }) => {
 *   if (strategy === 'agent-parallel') {
 *     const { policy, reasoning } = decision as { policy: ParallelPolicy; reasoning: string };
 *     console.log('Policy:', policy);
 *     console.log('Reasoning:', reasoning);
 *   }
 * });
 * ```
 */
export class AgentParallelStrategy implements ParallelStrategy {
  /**
   * Cached result from a previous `policy()` call.
   * `null` when caching is disabled or `reset()` has been called.
   */
  private cachedPolicy: ParallelPolicy | null = null;

  constructor(private config: AgentStrategyConfig) {}

  /**
   * Clear the cached policy so the next tick calls the SDK again.
   *
   * Only has an effect when `cache: true` was set in the config.
   */
  reset(): void {
    this.cachedPolicy = null;
  }

  /**
   * Return the {@link ParallelPolicy} Claude recommends for this tick.
   *
   * Builds a prompt from the config and current blackboard state, calls the
   * SDK, and returns the policy from Claude's structured response. Falls back
   * to `{ successCount: children.length }` (all children must succeed) if
   * the SDK call fails.
   */
  async policy(children: BTreeNode[], context: TreeContext): Promise<ParallelPolicy> {
    if (this.config.cache && this.cachedPolicy !== null) {
      return this.cachedPolicy;
    }

    const prompt = buildStrategyPrompt(this.config, children, context);
    const result = await queryStructured(prompt, PolicySchema, this.config);

    // SDK call failed — fall back to the strictest default (all must succeed)
    // so the parallel node remains safe and predictable.
    if (!result) {
      return { successCount: children.length };
    }

    context.events.emit('strategy:decision', {
      // The strategy doesn't have a reference to the parent composite node,
      // so the first child is used as a proxy identifier in the event payload.
      composite: children[0] ?? ({ id: '', name: '' } as any),
      strategy: 'agent-parallel',
      decision: result,
    });

    if (this.config.cache) this.cachedPolicy = result.policy;
    return result.policy;
  }
}
