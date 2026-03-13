import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type {
  ParallelConfig,
  TreeContext,
  ParallelStrategy,
  ParallelPolicy,
  BTreeNode,
} from '../types.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';
import { isReactiveNode } from './is-reactive-node.js';

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
 * ## Reactive tick model
 *
 * `ParallelNode` distinguishes between reactive and non-reactive children.
 * Reactive children (conditions, decorators wrapping conditions) are
 * re-ticked on every call to `execute()`. Non-reactive children that have
 * already returned a terminal status (SUCCESS or FAILURE) within the
 * current cycle are cached and not re-ticked until the cycle ends.
 *
 * A cycle ends when all children have resolved to a terminal status and
 * the policy has been evaluated, or when `reset()` / `abort()` is called.
 *
 * ## Scoped AbortControllers
 *
 * Each child receives its own `AbortController` whose signal is linked to
 * the parent context's signal. When `abort()` is called or a cycle ends,
 * all child controllers are aborted and cleared.
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

  /**
   * Caches terminal results for non-reactive children within a cycle.
   * Reactive children are always re-ticked and never cached here.
   */
  private completedMap: Map<BTreeNode, NodeStatus> = new Map();

  /**
   * Scoped AbortControllers per child, linked to the parent context's signal.
   * Created lazily on first tick and cleared when the cycle ends.
   */
  private childControllers: Map<BTreeNode, AbortController> = new Map();

  /**
   * The committed policy for the current execution cycle.
   * Set on the first tick of a cycle and cleared when the cycle ends
   * (all children resolve) or when `reset()` / `abort()` is called.
   */
  private committedPolicy: ParallelPolicy | null = null;

  override get children(): readonly BTreeNode[] {
    return this._children;
  }

  constructor(config: ParallelConfig) {
    super(config.name, config.id);
    this._children = [...config.children];
    this.strategy = config.strategy ?? new DefaultParallelStrategy();
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // Commit the policy once per execution cycle. The strategy is only
    // consulted when starting a new cycle (committedPolicy is null).
    if (this.committedPolicy === null) {
      this.committedPolicy = await this.strategy.policy(this._children, context);
    }
    const policy = this.committedPolicy;

    // Tick all children concurrently. Non-reactive children that already
    // completed in this cycle use their cached result. Reactive children
    // are always re-ticked.
    const results = await Promise.all(
      this._children.map(async (child) => {
        // Return cached result for non-reactive completed children
        if (!isReactiveNode(child) && this.completedMap.has(child)) {
          return this.completedMap.get(child)!;
        }

        // Get or create a scoped AbortController for this child
        let controller = this.childControllers.get(child);
        if (!controller) {
          controller = new AbortController();
          if (context.signal) {
            if (context.signal.aborted) {
              controller.abort();
            } else {
              context.signal.addEventListener('abort', () => controller!.abort(), { once: true });
            }
          }
          this.childControllers.set(child, controller);
        }

        const childContext: TreeContext = { ...context, signal: controller.signal };
        const status = await child.tick(childContext);

        // Cache terminal results for non-reactive children
        if (!isReactiveNode(child) && status !== NodeStatus.RUNNING) {
          this.completedMap.set(child, status);
        }

        return status;
      }),
    );

    // If any child is still in progress, defer policy evaluation until
    // all children have produced a terminal status.
    if (results.includes(NodeStatus.RUNNING)) {
      return NodeStatus.RUNNING;
    }

    // All children resolved — evaluate policy and end the cycle.
    const finalStatus = this.evaluatePolicy(results, policy);
    this.abortAllChildren();
    this.clearCycle();
    return finalStatus;
  }

  /**
   * Evaluate the parallel policy against the collected results.
   * Uses the same logic as before: failureCount, successPercentage,
   * successCount, then default (all must succeed).
   */
  private evaluatePolicy(results: NodeStatus[], policy: ParallelPolicy): NodeStatus {
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
   * Abort all child controllers and call abort() on all children.
   */
  private abortAllChildren(): void {
    for (const controller of this.childControllers.values()) {
      controller.abort();
    }
    for (const child of this._children) {
      child.abort();
    }
  }

  /**
   * Clear all cycle state: completion map, child controllers, committed policy.
   */
  private clearCycle(): void {
    this.completedMap.clear();
    this.childControllers.clear();
    this.committedPolicy = null;
  }

  /**
   * Reset this parallel node and all of its children to their initial states.
   *
   * Clears cycle state (completion map, child controllers, committed policy),
   * calls `reset()` on the strategy (if it implements one — agent strategies
   * use this to clear cached policies) and cascades `reset()` to every child.
   */
  reset(): void {
    this.clearCycle();
    this.strategy.reset?.();
    for (const child of this.children) {
      child.reset();
    }
  }

  /**
   * Abort all children and clear all cycle state.
   *
   * Called when `BehaviorTree.abort()` is invoked. Each child's scoped
   * controller is aborted, and child.abort() is called on all children.
   */
  abort(): void {
    this.abortAllChildren();
    this.clearCycle();
  }
}
