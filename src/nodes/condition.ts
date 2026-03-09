import { BaseNode } from './base.js';
import { NodeStatus } from '../types.js';
import type { ConditionNodeConfig, TreeContext } from '../types.js';

/**
 * A leaf node that evaluates a boolean predicate when ticked.
 *
 * `ConditionNode` maps a true/false check onto `SUCCESS`/`FAILURE`.
 * It never returns `RUNNING` — conditions are always instantaneous.
 *
 * Conditions are most useful as the first child of a `SequenceNode`,
 * acting as a gate that must pass before subsequent actions are attempted.
 * They can also be used inside a `SelectorNode` as a fast "is this already
 * done?" check before falling back to a more expensive action.
 *
 * The predicate receives the full {@link TreeContext} and can read from
 * the blackboard, inspect the abort signal, or perform any synchronous or
 * asynchronous check.
 *
 * Exceptions thrown by the predicate are caught by `BaseNode.tick()` and
 * treated as `FAILURE`.
 *
 * **Blackboard presence check:**
 * ```ts
 * const hasToken = new ConditionNode({
 *   name: 'has-auth-token',
 *   condition: (context) => context.blackboard.has('authToken'),
 * });
 * ```
 *
 * **Value comparison:**
 * ```ts
 * const isAdult = new ConditionNode({
 *   name: 'is-adult',
 *   condition: (context) => {
 *     const age = context.blackboard.get<number>('userAge') ?? 0;
 *     return age >= 18;
 *   },
 * });
 * ```
 *
 * **Async check (e.g. cache hit):**
 * ```ts
 * const isCached = new ConditionNode({
 *   name: 'is-cached',
 *   condition: async (context) => {
 *     const key = context.blackboard.get<string>('cacheKey');
 *     return key ? await cache.has(key) : false;
 *   },
 * });
 * ```
 *
 * **Gating a sequence:**
 * ```ts
 * // The sequence only proceeds to 'fetch-data' if the user is authenticated.
 * const sequence = new SequenceNode({
 *   name: 'authenticated-fetch',
 *   children: [hasToken, fetchData],
 * });
 * ```
 */
export class ConditionNode extends BaseNode {
  private condition: ConditionNodeConfig['condition'];

  constructor(config: ConditionNodeConfig) {
    super(config.name);
    this.condition = config.condition;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const result = await this.condition(context);
    return result ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}
