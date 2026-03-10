import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { SelectorConfig, TreeContext, SelectionStrategy, BTreeNode } from '../types.js';
import { DefaultSelectionStrategy } from '../strategies/default-selection.js';

/**
 * A composite node that succeeds as soon as any child succeeds (OR logic).
 *
 * `SelectorNode` tries each child in order and returns:
 * - `SUCCESS` — the moment a child returns `SUCCESS` (remaining children are skipped).
 * - `RUNNING` — when a child returns `RUNNING` (selector pauses and remembers that child).
 * - `FAILURE` — when every child has returned `FAILURE`.
 *
 * This "try the first option, fall back to the next" pattern mirrors an
 * `if / else if / else` chain, which is why selectors are sometimes called
 * *fallback nodes*.
 *
 * **Basic fallback chain:**
 * ```ts
 * const getUser = new SelectorNode({
 *   name: 'get-user',
 *   children: [
 *     fromCache,   // Try the fast path first
 *     fromDatabase // Fall back to the database if cache misses
 *   ],
 * });
 * ```
 *
 * **Combining with conditions to guard actions:**
 * ```ts
 * // Returns SUCCESS immediately if the user is already authenticated.
 * // Only attempts the login action if the condition fails.
 * const ensureAuth = new SelectorNode({
 *   name: 'ensure-auth',
 *   children: [isAuthenticated, loginAction],
 * });
 * ```
 *
 * ## RUNNING and resumption
 *
 * When a child returns `RUNNING`, the selector records that child's ID and
 * returns `RUNNING` itself. On the next tick the selector resumes from that
 * child — skipping siblings that already failed — until the child resolves
 * to `SUCCESS` or `FAILURE`.
 *
 * Resumption is ID-based, not index-based, so it works correctly even when
 * a {@link SelectionStrategy} returns a different order on a subsequent
 * execution cycle.
 *
 * ## Order commitment
 *
 * The strategy is consulted once per execution cycle — when the selector
 * starts fresh (no child is RUNNING). The returned order is committed for
 * the duration of that cycle. Subsequent ticks that resume a RUNNING child
 * reuse the committed order without calling the strategy again. The
 * committed order is cleared when the cycle ends (SUCCESS or FAILURE) or
 * when `reset()` is called.
 *
 * ## Strategy injection
 *
 * An optional {@link SelectionStrategy} controls child evaluation order.
 * The default strategy preserves the original insertion order. Use
 * `AgentSelectionStrategy` to let Claude pick the most promising child
 * based on the current blackboard state.
 *
 * ```ts
 * const adaptive = new SelectorNode({
 *   name: 'adaptive-selector',
 *   children: [cheapAction, thoroughAction, fallbackAction],
 *   strategy: new AgentSelectionStrategy({
 *     prompt: 'Choose the best approach given the current context',
 *   }),
 * });
 * ```
 */
export class SelectorNode extends BaseNode {
  private children: SelectorConfig['children'];
  private strategy: SelectionStrategy;

  /**
   * The ID of the child that returned `RUNNING` on the previous tick.
   * `null` when no child is currently mid-execution.
   */
  private runningChildId: string | null = null;

  /**
   * The committed child order for the current execution cycle.
   * Set on the first tick of a cycle and cleared on terminal results
   * (SUCCESS/FAILURE) or `reset()`. While non-null, the strategy is
   * not re-consulted.
   */
  private committedOrder: BTreeNode[] | null = null;

  constructor(config: SelectorConfig) {
    super(config.name);
    this.children = config.children;
    this.strategy = config.strategy ?? new DefaultSelectionStrategy();
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // Commit the child order once per execution cycle. The strategy is only
    // consulted when starting a new cycle (committedOrder is null). While a
    // child is RUNNING the committed order is stable across ticks.
    if (this.committedOrder === null) {
      this.committedOrder = await this.strategy.order(this.children, context);
    }
    const ordered = this.committedOrder;

    // If a child was RUNNING on the previous tick, find it in the committed
    // order by ID and resume from that position.
    let startIndex = 0;
    if (this.runningChildId !== null) {
      const resumeIndex = ordered.findIndex((c) => c.id === this.runningChildId);
      if (resumeIndex !== -1) {
        startIndex = resumeIndex;
      }
    }

    for (let i = startIndex; i < ordered.length; i++) {
      const status = await ordered[i].tick(context);
      if (status === NodeStatus.RUNNING) {
        this.runningChildId = ordered[i].id;
        return NodeStatus.RUNNING;
      }
      if (status === NodeStatus.SUCCESS) {
        this.runningChildId = null;
        this.committedOrder = null;
        return NodeStatus.SUCCESS;
      }
      // FAILURE: continue to the next child
    }

    this.runningChildId = null;
    this.committedOrder = null;
    return NodeStatus.FAILURE;
  }

  /**
   * Reset this selector and all of its children to their initial states.
   *
   * Clears the running-child record, calls `reset()` on the strategy
   * (if it implements one — agent strategies use this to clear cached
   * orderings), and cascades `reset()` to every child node.
   */
  reset(): void {
    this.runningChildId = null;
    this.committedOrder = null;
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
