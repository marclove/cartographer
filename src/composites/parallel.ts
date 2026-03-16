import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import { computeContentHash } from '../core/content-hash.js';
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
   * Cleanup functions that remove parent-signal listeners added during the
   * current cycle. Called by {@link clearCycle} to prevent listener leaks.
   */
  private signalCleanups: (() => void)[] = [];

  /**
   * The committed policy for the current execution cycle.
   * Set on the first tick of a cycle and cleared when the cycle ends
   * (all children resolve) or when `reset()` / `abort()` is called.
   */
  private committedPolicy: ParallelPolicy | null = null;

  override get children(): readonly BTreeNode[] {
    return this._children;
  }

  protected override computeHash(): string {
    return computeContentHash('ParallelNode', this._children.map(c => c.contentHash()));
  }

  constructor(config: ParallelConfig) {
    super(config.name, config.id);
    this._children = [...config.children];
    this.strategy = config.strategy ?? new DefaultParallelStrategy();
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // --- Phase 1: Resolve the policy for this cycle ---
    // The policy determines how many children must succeed/fail for the
    // parallel to resolve. It is committed once on the first tick of a
    // cycle and reused on subsequent ticks so that the success criteria
    // remain stable while children are still running. Agent strategies
    // (e.g., AgentParallelStrategy) may call Claude here, which is why
    // this is async and only runs once per cycle.
    if (this.committedPolicy === null) {
      this.committedPolicy = await this.strategy.policy(this._children, context);
    }
    const policy = this.committedPolicy;

    // --- Phase 2: Tick all children concurrently ---
    // Every child is dispatched in parallel via Promise.all. Two kinds of
    // children are handled differently:
    //
    //   Reactive (conditions, guards): Always re-ticked on every call to
    //   execute(). This allows conditions to "trip" mid-cycle and change
    //   the outcome even after they previously succeeded.
    //
    //   Non-reactive (actions, agents, composites): Ticked until they
    //   return a terminal status (SUCCESS or FAILURE), then their result
    //   is cached in completedMap for the rest of the cycle. This avoids
    //   redundantly re-running expensive work like API calls.
    const results = await Promise.all(
      this._children.map(async (child) => {
        // Non-reactive child already finished this cycle — return the
        // cached terminal result without ticking again.
        if (!isReactiveNode(child) && this.completedMap.has(child)) {
          return this.completedMap.get(child)!;
        }

        // --- Scoped AbortController per child ---
        // Each child gets its own AbortController so that individual
        // children can be cancelled without affecting siblings. The
        // child's controller is linked to the parent context's signal:
        // if the tree is aborted externally, the abort propagates down
        // to every child automatically.
        let controller = this.childControllers.get(child);
        if (!controller) {
          controller = new AbortController();
          if (context.signal) {
            // If the parent signal is already aborted (e.g., tree was
            // aborted between ticks), immediately abort this child too.
            if (context.signal.aborted) {
              controller.abort();
            } else {
              // Forward future parent aborts to this child's controller.
              // The cleanup function is stored so we can remove the
              // listener when the cycle ends, preventing memory leaks.
              const handler = () => controller!.abort();
              context.signal.addEventListener('abort', handler, { once: true });
              const signal = context.signal;
              this.signalCleanups.push(() => signal.removeEventListener('abort', handler));
            }
          }
          this.childControllers.set(child, controller);
        }

        // Pass the child-scoped signal so the child can respond to
        // cancellation independently of its siblings.
        const childContext: TreeContext = { ...context, signal: controller.signal };
        const status = await child.tick(childContext);

        // Cache terminal results for non-reactive children so they
        // are not re-ticked on subsequent calls within this cycle.
        if (!isReactiveNode(child) && status !== NodeStatus.RUNNING) {
          this.completedMap.set(child, status);
        }

        return status;
      }),
    );

    // --- Phase 3: Evaluate the policy ---
    // The policy is checked against the current snapshot of results.
    // Some policies can short-circuit with partial results (e.g.,
    // failureCount threshold already met, or successCount already met),
    // while percentage-based policies must wait for all children to
    // resolve since the denominator isn't known until then.
    //
    // evaluatePolicy returns RUNNING when no terminal decision can be
    // made yet — the parallel will be ticked again on the next tree tick.
    const hasRunning = results.includes(NodeStatus.RUNNING);
    const finalStatus = this.evaluatePolicy(results, policy, hasRunning);

    // If the outcome is still indeterminate, keep the cycle alive so
    // that running children continue on the next tick.
    if (finalStatus === NodeStatus.RUNNING) {
      return NodeStatus.RUNNING;
    }

    // --- Phase 4: Cycle cleanup ---
    // The policy has reached a terminal verdict (SUCCESS or FAILURE).
    // Abort any children still running (they are no longer needed),
    // then clear all cycle state (completion cache, child controllers,
    // committed policy) so the next execution cycle starts fresh.
    this.abortAllChildren();
    this.clearCycle();
    return finalStatus;
  }

  /**
   * Evaluate the parallel policy against the collected results.
   *
   * When `hasRunning` is true, only policies that can be determined from
   * partial results will short-circuit:
   * - `failureCount` — threshold already met → FAILURE
   * - `successCount` — threshold already met → SUCCESS
   * - default (all must succeed) — any failure → FAILURE
   *
   * Percentage-based policies defer until all children resolve because
   * the denominator (total count) isn't meaningful with RUNNING children.
   *
   * Returns RUNNING when a terminal outcome cannot yet be determined.
   */
  private evaluatePolicy(
    results: NodeStatus[],
    policy: ParallelPolicy,
    hasRunning: boolean,
  ): NodeStatus {
    const successCount = results.filter((r) => r === NodeStatus.SUCCESS).length;
    const failureCount = results.filter((r) => r === NodeStatus.FAILURE).length;

    // failureCount threshold is checked first — it can veto success even if
    // a successCount/successPercentage target would otherwise be satisfied.
    if (policy.failureCount !== undefined && failureCount >= policy.failureCount) {
      return NodeStatus.FAILURE;
    }

    if (policy.successPercentage !== undefined) {
      // Percentage requires all children to have resolved — defer if any RUNNING.
      if (hasRunning) return NodeStatus.RUNNING;
      const percentage = (successCount / results.length) * 100;
      return percentage >= policy.successPercentage ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
    }

    if (policy.successCount !== undefined) {
      if (successCount >= policy.successCount) return NodeStatus.SUCCESS;
      // Check if the threshold is impossible to meet: remaining children
      // (RUNNING) can't close the gap even if they all succeed.
      const runningCount = results.filter((r) => r === NodeStatus.RUNNING).length;
      if (successCount + runningCount < policy.successCount) return NodeStatus.FAILURE;
      // Threshold still reachable — defer if children are still running.
      if (hasRunning) return NodeStatus.RUNNING;
      return NodeStatus.FAILURE;
    }

    // Default: require all children to succeed (zero failures allowed).
    if (failureCount > 0) return NodeStatus.FAILURE;
    if (hasRunning) return NodeStatus.RUNNING;
    return NodeStatus.SUCCESS;
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
    for (const cleanup of this.signalCleanups) cleanup();
    this.signalCleanups = [];
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
