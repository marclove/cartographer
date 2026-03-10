import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { ParallelConfig, TreeContext, ParallelStrategy, BTreeNode } from '../types.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';

/**
 * A composite node that ticks all children concurrently on every tick.
 *
 * Unlike {@link SequenceNode} and {@link SelectorNode}, which tick children
 * one at a time, `ParallelNode` ticks *all* children simultaneously using
 * `Promise.all`. A configurable {@link ParallelPolicy} then determines
 * whether the combined results constitute success or failure.
 *
 * **Tick behaviour (in evaluation order):**
 * 1. All children are ticked concurrently.
 * 2. If *any* child returns `RUNNING`, the parallel returns `RUNNING`
 *    immediately — policy evaluation is skipped until no child is running.
 * 3. Once all children have resolved, the policy is applied:
 *    - `failureCount` — if at least that many children failed → `FAILURE`.
 *    - `successPercentage` — if the success ratio meets the threshold → `SUCCESS`, else `FAILURE`.
 *    - `successCount` — if at least that many children succeeded → `SUCCESS`, else `FAILURE`.
 *    - *(default, no policy fields set)* — all children must succeed → `SUCCESS` only if zero failures.
 *
 *    The checks above are applied in the order listed. `failureCount` is
 *    evaluated before success thresholds, so it can short-circuit to
 *    `FAILURE` even when a `successCount`/`successPercentage` target
 *    would otherwise be satisfied.
 *
 * > **Note:** `ParallelNode` does not track which child is running between
 * > ticks. All children are re-ticked on every call to `execute()`.
 * > Stateful children (e.g. long-running `ActionNode`s) are responsible for
 * > managing their own in-progress state across ticks.
 *
 * **Require all children to succeed (default):**
 * ```ts
 * const validate = new ParallelNode({
 *   name: 'validate-all',
 *   children: [checkSchema, checkAuth, checkRateLimit],
 *   // No strategy needed — default requires all three to succeed
 * });
 * ```
 *
 * **Majority vote (at least 2 of 3):**
 * ```ts
 * const quorum = new ParallelNode({
 *   name: 'quorum-check',
 *   children: [serviceA, serviceB, serviceC],
 *   strategy: new DefaultParallelStrategy({ successCount: 2 }),
 * });
 * ```
 *
 * **Percentage threshold:**
 * ```ts
 * const mostlyGood = new ParallelNode({
 *   name: 'health-check',
 *   children: nodes, // e.g. 10 service nodes
 *   strategy: new DefaultParallelStrategy({ successPercentage: 80 }),
 * });
 * ```
 *
 * **Fail fast on first failure:**
 * ```ts
 * const anyFailure = new ParallelNode({
 *   name: 'strict-parallel',
 *   children: [stepA, stepB, stepC],
 *   strategy: new DefaultParallelStrategy({ failureCount: 1 }),
 * });
 * ```
 *
 * ## Strategy injection
 *
 * An optional {@link ParallelStrategy} is called at the start of every tick
 * to determine the policy. Use `AgentParallelStrategy` to let Claude decide
 * dynamically how many children must succeed based on the current context.
 *
 * ```ts
 * const dynamic = new ParallelNode({
 *   name: 'dynamic-checks',
 *   children: [checkA, checkB, checkC],
 *   strategy: new AgentParallelStrategy({
 *     prompt: 'Decide how many checks must pass given the current risk level',
 *     cache: true,
 *   }),
 * });
 * ```
 */
export class ParallelNode extends BaseNode {
  private _children: BTreeNode[];
  private strategy: ParallelStrategy;

  override get children(): readonly BTreeNode[] {
    return this._children;
  }

  constructor(config: ParallelConfig) {
    super(config.name, config.id);
    this._children = [...config.children];
    this.strategy = config.strategy ?? new DefaultParallelStrategy();
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // Obtain the policy before ticking children — agent strategies may
    // consult the blackboard to decide thresholds dynamically.
    const policy = await this.strategy.policy(this._children, context);

    // Tick all children concurrently. Every child is ticked on every call,
    // regardless of what it returned on previous ticks.
    const results = await Promise.all(this._children.map((child) => child.tick(context)));

    // If any child is still in progress, defer policy evaluation until
    // all children have produced a terminal status.
    if (results.includes(NodeStatus.RUNNING)) {
      return NodeStatus.RUNNING;
    }

    const successCount = results.filter((r) => r === NodeStatus.SUCCESS).length;
    const failureCount = results.filter((r) => r === NodeStatus.FAILURE).length;

    // failureCount threshold is checked first — it can veto success even if
    // a successCount/successPercentage target would otherwise be satisfied.
    if (policy.failureCount !== undefined && failureCount >= policy.failureCount) {
      return NodeStatus.FAILURE;
    }

    if (policy.successPercentage !== undefined) {
      const percentage = (successCount / results.length) * 100;
      return percentage >= policy.successPercentage ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
    }

    if (policy.successCount !== undefined) {
      return successCount >= policy.successCount ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
    }

    // Default: require all children to succeed (zero failures allowed).
    return failureCount === 0 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }

  /**
   * Reset this parallel node and all of its children to their initial states.
   *
   * Calls `reset()` on the strategy (if it implements one — agent strategies
   * use this to clear cached policies) and cascades `reset()` to every child.
   */
  reset(): void {
    this.strategy.reset?.();
    for (const child of this.children) {
      child.reset();
    }
  }

  /**
   * Propagate an abort signal to all child nodes.
   *
   * Called when `BehaviorTree.abort()` is invoked. Each child is
   * responsible for cancelling any in-progress work it owns.
   */
  abort(): void {
    for (const child of this.children) {
      child.abort();
    }
  }
}
