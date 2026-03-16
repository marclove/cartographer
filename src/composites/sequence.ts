import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { SequenceConfig, TreeContext, ExecutionStrategy, BTreeNode } from '../types.js';
import type { NodeState } from '../core/serialization.js';
import { DefaultExecutionStrategy } from '../strategies/default-execution.js';
import { isReactiveNode } from './is-reactive-node.js';
import { computeContentHash } from '../core/content-hash.js';

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

  protected override computeHash(): string {
    return computeContentHash('SequenceNode', this._children.map(c => c.contentHash()));
  }

  override serialize(): NodeState {
    const state: NodeState = {};
    if (this.committedOrder) {
      state.committedOrder = this.committedOrder.map(child => child.contentHash());
    }
    if (this.completedMap.size > 0) {
      state.completedMap = {};
      for (const [node, status] of this.completedMap) {
        state.completedMap[node.contentHash()] = status;
      }
    }
    return state;
  }

  override restore(state: NodeState, hashToNode: Map<string, BTreeNode>): void {
    if (state.committedOrder) {
      this.committedOrder = state.committedOrder
        .map(hash => hashToNode.get(hash))
        .filter((n): n is BTreeNode => n !== undefined);
    }
    if (state.completedMap) {
      this.completedMap.clear();
      for (const [hash, status] of Object.entries(state.completedMap)) {
        const node = hashToNode.get(hash);
        if (node) {
          this.completedMap.set(node, status);
        }
      }
    }
  }

  constructor(config: SequenceConfig) {
    super(config.name, config.id);
    this._children = [...config.children];
    this.strategy = config.strategy ?? new DefaultExecutionStrategy();
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // --- Phase 1: Resolve child order for this cycle ---
    // The strategy determines execution order. It is consulted once on
    // the first tick of a cycle and committed for all subsequent ticks,
    // ensuring a stable evaluation order while children are running.
    // Agent strategies (e.g., AgentExecutionStrategy) may call Claude
    // here to reorder steps based on current blackboard state.
    if (this.committedOrder === null) {
      this.committedOrder = await this.strategy.order(this._children, context);
    }
    const ordered = this.committedOrder;

    // --- Phase 2: Evaluate children sequentially (AND logic) ---
    // Children are ticked one at a time in the committed order. The
    // sequence succeeds only when every child succeeds, and fails the
    // moment any child fails (short-circuit). This models a multi-step
    // procedure: check a condition, perform an action, store a result.
    for (const child of ordered) {
      // --- Scoped AbortController per child ---
      // Each child gets its own controller so it can be individually
      // cancelled when the sequence short-circuits on FAILURE. The
      // controller is linked to the parent signal so tree-wide aborts
      // cascade down automatically.
      let controller = this.childControllers.get(child);
      if (!controller) {
        controller = new AbortController();
        if (context.signal) {
          // If the parent was already aborted between ticks, propagate
          // immediately so the child sees the abort on its first tick.
          if (context.signal.aborted) {
            controller.abort();
          } else {
            // Forward future parent aborts to this child. The cleanup
            // is stored so we can remove the listener when the cycle
            // ends, preventing memory leaks in long-running trees.
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

      // Non-reactive children that already finished this cycle use
      // their cached result. Reactive children (conditions, guards)
      // are always re-ticked so they can detect predicate changes —
      // e.g., a guard condition that was true on tick 1 may now be
      // false, causing the sequence to fail and preempt running work.
      if (!isReactiveNode(child) && this.completedMap.has(child)) {
        status = this.completedMap.get(child)!;
      } else {
        status = await child.tick(childContext);
        // Cache terminal results for non-reactive children so they
        // are not re-ticked on subsequent calls within this cycle.
        if (!isReactiveNode(child) && status !== NodeStatus.RUNNING) {
          this.completedMap.set(child, status);
        }
      }

      // --- Short-circuit on FAILURE ---
      // A sequence fails the moment any child fails. Abort all
      // children (including any still-running siblings from earlier
      // ticks) and clear the cycle so the next execution starts fresh.
      if (status === NodeStatus.FAILURE) {
        this.abortAllChildren();
        this.clearCycle();
        return NodeStatus.FAILURE;
      }

      // --- Pause on RUNNING ---
      // This child is still in progress. Return RUNNING to the parent
      // so the tree scheduler will tick us again. The cycle state
      // (committed order, cached results, controllers) is preserved
      // so the next tick resumes where we left off.
      if (status === NodeStatus.RUNNING) {
        return NodeStatus.RUNNING;
      }

      // SUCCESS: this step passed — continue to the next child.
    }

    // --- Phase 3: All children succeeded ---
    // Every child returned SUCCESS — the full procedure completed.
    // Clear the cycle so the next execution starts with a fresh
    // strategy call.
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
