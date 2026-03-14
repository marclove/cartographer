import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { SelectorConfig, TreeContext, SelectionStrategy, BTreeNode } from '../types.js';
import { DefaultSelectionStrategy } from '../strategies/default-selection.js';
import { isReactiveNode } from './is-reactive-node.js';

/**
 * A composite node that succeeds as soon as any child succeeds (OR logic).
 *
 * `SelectorNode` tries each child in order and returns:
 * - `SUCCESS` — the moment a child returns `SUCCESS` (remaining children are skipped).
 * - `RUNNING` — when a child returns `RUNNING` (selector pauses at that child).
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
 * ## Reactive re-evaluation
 *
 * On every tick the selector re-evaluates children from the start. Reactive
 * children (conditions and single-child decorators wrapping conditions) are
 * always re-ticked. Non-reactive children that already returned a terminal
 * status within the current cycle return their cached result.
 *
 * If a higher-priority branch succeeds while a lower-priority branch is
 * RUNNING, the lower-priority branch is aborted via its scoped
 * AbortController and the selector returns SUCCESS immediately.
 *
 * ## Order commitment
 *
 * The strategy is consulted once per execution cycle — when the selector
 * starts fresh (no cycle in progress). The returned order is committed for
 * the duration of that cycle. Subsequent ticks reuse the committed order
 * without calling the strategy again. The committed order is cleared when
 * the cycle ends (SUCCESS or FAILURE) or when `reset()` is called.
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
  private _children: BTreeNode[];
  private strategy: SelectionStrategy;

  /**
   * Caches terminal results for non-reactive children within the current
   * execution cycle. Cleared when the cycle ends or on reset/abort.
   */
  private completedMap: Map<BTreeNode, NodeStatus> = new Map();

  /**
   * Scoped AbortControllers per child, created once per cycle and reused
   * across ticks. On preemption or cycle end, controllers are aborted and
   * cleared.
   */
  private childControllers: Map<BTreeNode, AbortController> = new Map();

  /**
   * Cleanup functions that remove parent-signal listeners added during the
   * current cycle. Called by {@link clearCycle} to prevent listener leaks.
   */
  private signalCleanups: (() => void)[] = [];

  /**
   * The committed child order for the current execution cycle.
   * Set on the first tick of a cycle and cleared on terminal results
   * (SUCCESS/FAILURE) or `reset()`. While non-null, the strategy is
   * not re-consulted.
   */
  private committedOrder: BTreeNode[] | null = null;

  override get children(): readonly BTreeNode[] {
    return this._children;
  }

  constructor(config: SelectorConfig) {
    super(config.name, config.id);
    this._children = [...config.children];
    this.strategy = config.strategy ?? new DefaultSelectionStrategy();
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // Commit the child order once per execution cycle.
    if (this.committedOrder === null) {
      this.committedOrder = await this.strategy.order(this._children, context);
    }
    const ordered = this.committedOrder;

    for (let i = 0; i < ordered.length; i++) {
      const child = ordered[i];

      // Get or create a scoped AbortController for this child.
      let controller = this.childControllers.get(child);
      if (!controller) {
        controller = new AbortController();
        if (context.signal) {
          if (context.signal.aborted) {
            controller.abort();
          } else {
            const handler = () => controller!.abort();
            context.signal.addEventListener('abort', handler, { once: true });
            const signal = context.signal;
            this.signalCleanups.push(() => signal.removeEventListener('abort', handler));
          }
        }
        this.childControllers.set(child, controller);
      }

      const childContext = { ...context, signal: controller.signal };

      let status: NodeStatus;

      if (!isReactiveNode(child) && this.completedMap.has(child)) {
        status = this.completedMap.get(child)!;
      } else {
        status = await child.tick(childContext);
        if (!isReactiveNode(child) && status !== NodeStatus.RUNNING) {
          this.completedMap.set(child, status);
        }
      }

      if (status === NodeStatus.SUCCESS) {
        this.abortAllChildren();
        this.clearCycle();
        return NodeStatus.SUCCESS;
      }

      if (status === NodeStatus.RUNNING) {
        return NodeStatus.RUNNING;
      }

      // FAILURE: try next child
    }

    this.clearCycle();
    return NodeStatus.FAILURE;
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
   * Clear all cycle state — completion cache, child controllers, and
   * committed order.
   */
  private clearCycle(): void {
    for (const cleanup of this.signalCleanups) cleanup();
    this.signalCleanups = [];
    this.completedMap.clear();
    this.childControllers.clear();
    this.committedOrder = null;
  }

  /**
   * Reset this selector and all of its children to their initial states.
   *
   * Clears cycle state, calls `reset()` on the strategy (if it implements
   * one — agent strategies use this to clear cached orderings), and cascades
   * `reset()` to every child node.
   */
  reset(): void {
    this.clearCycle();
    this.strategy.reset?.();
    for (const child of this.children) {
      child.reset();
    }
  }

  /**
   * Abort all in-progress children and clear cycle state.
   *
   * Called when `BehaviorTree.abort()` is invoked or when this subtree
   * is preempted by a parent composite.
   */
  abort(): void {
    this.abortAllChildren();
    this.clearCycle();
  }
}
