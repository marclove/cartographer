import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { SequenceConfig, TreeContext, ExecutionStrategy, BTreeNode } from '../types.js';
import { DefaultExecutionStrategy } from '../strategies/default-execution.js';
import { isReactiveNode } from './is-reactive-node.js';

/**
 * A composite node that succeeds only when every child succeeds (AND logic).
 *
 * `SequenceNode` ticks children one at a time in order and returns:
 * - `SUCCESS` — when all children have returned `SUCCESS`.
 * - `FAILURE` — the moment any child returns `FAILURE` (remaining children are skipped).
 * - `RUNNING` — when a child returns `RUNNING` (sequence pauses at that child).
 *
 * This "every step must succeed" pattern mirrors an `&&` chain, which is
 * why sequences are sometimes called *and-nodes*. They are the most common
 * composite for expressing multi-step procedures: check a condition, then
 * perform an action, then store a result.
 *
 * ## Reactive re-evaluation
 *
 * On every tick the sequence re-evaluates from the first child. Reactive
 * nodes (conditions, decorators wrapping conditions) are always re-ticked.
 * Non-reactive nodes that have already completed within the current cycle
 * return their cached result without being re-ticked. This allows conditions
 * to preempt long-running actions when their predicates change.
 *
 * ## Scoped AbortControllers
 *
 * Each child receives a scoped `AbortController` for the duration of the
 * cycle. When the sequence short-circuits on FAILURE or the cycle ends,
 * all child controllers are aborted. The parent signal (if any) is bridged
 * to each child controller so tree-wide aborts cascade correctly.
 *
 * ## Order commitment
 *
 * The strategy is consulted once per execution cycle — when the sequence
 * starts fresh (committedOrder is null). The returned order is committed for
 * the duration of that cycle. The committed order is cleared when the cycle
 * ends (SUCCESS or FAILURE) or when `reset()` is called.
 *
 * ## Strategy injection
 *
 * An optional {@link ExecutionStrategy} controls child execution order.
 * The default strategy preserves the original insertion order.
 */
export class SequenceNode extends BaseNode {
  private _children: BTreeNode[];
  private strategy: ExecutionStrategy;

  /**
   * The committed child order for the current execution cycle.
   * Set on the first tick of a cycle and cleared on terminal results
   * (SUCCESS/FAILURE) or `reset()`. While non-null, the strategy is
   * not re-consulted.
   */
  private committedOrder: BTreeNode[] | null = null;

  /**
   * Caches terminal results for non-reactive children within a cycle.
   * Reactive nodes (conditions) are always re-ticked and never cached.
   */
  private completedMap = new Map<BTreeNode, NodeStatus>();

  /**
   * Scoped AbortControllers per child for the current cycle.
   * Each child gets its own controller that is bridged to the parent signal.
   */
  private childControllers = new Map<BTreeNode, AbortController>();

  /**
   * Cleanup functions that remove parent-signal listeners added during the
   * current cycle. Called by {@link clearCycle} to prevent listener leaks
   * across cycles in long-running tick loops.
   */
  private signalCleanups: (() => void)[] = [];

  override get children(): readonly BTreeNode[] {
    return this._children;
  }

  constructor(config: SequenceConfig) {
    super(config.name, config.id);
    this._children = [...config.children];
    this.strategy = config.strategy ?? new DefaultExecutionStrategy();
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // Commit the child order once per execution cycle.
    if (this.committedOrder === null) {
      this.committedOrder = await this.strategy.order(this._children, context);
    }
    const ordered = this.committedOrder;

    for (const child of ordered) {
      // Get or create scoped controller for this child
      let controller = this.childControllers.get(child);
      if (!controller) {
        controller = new AbortController();
        // Bridge parent signal to child controller
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

      const childContext: TreeContext = { ...context, signal: controller.signal };

      let status: NodeStatus;

      if (!isReactiveNode(child) && this.completedMap.has(child)) {
        // Use cached result for non-reactive completed children
        status = this.completedMap.get(child)!;
      } else {
        status = await child.tick(childContext);
        // Cache terminal results for non-reactive children
        if (!isReactiveNode(child) && status !== NodeStatus.RUNNING) {
          this.completedMap.set(child, status);
        }
      }

      if (status === NodeStatus.FAILURE) {
        this.abortAllChildren();
        this.clearCycle();
        return NodeStatus.FAILURE;
      }

      if (status === NodeStatus.RUNNING) {
        return NodeStatus.RUNNING;
      }
      // SUCCESS: continue to the next child
    }

    this.clearCycle();
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
   * Clear all cycle state: completedMap, childControllers, committedOrder.
   */
  private clearCycle(): void {
    for (const cleanup of this.signalCleanups) cleanup();
    this.signalCleanups = [];
    this.completedMap.clear();
    this.childControllers.clear();
    this.committedOrder = null;
  }

  /**
   * Reset this sequence and all of its children to their initial states.
   *
   * Clears the cycle state, calls `reset()` on the strategy
   * (if it implements one), and cascades `reset()` to every child node.
   */
  reset(): void {
    this.clearCycle();
    this.strategy.reset?.();
    for (const child of this.children) {
      child.reset();
    }
  }

  /**
   * Abort all children and clear cycle state.
   *
   * Called when `BehaviorTree.abort()` is invoked. Each child is
   * responsible for cancelling any in-progress work it owns.
   */
  abort(): void {
    this.abortAllChildren();
    this.clearCycle();
  }
}
