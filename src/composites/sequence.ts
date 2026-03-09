import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { SequenceConfig, TreeContext, ExecutionStrategy } from '../types.js';
import { DefaultExecutionStrategy } from '../strategies/default-execution.js';

/**
 * A composite node that succeeds only when every child succeeds (AND logic).
 *
 * `SequenceNode` ticks children one at a time in order and returns:
 * - `SUCCESS` — when all children have returned `SUCCESS`.
 * - `FAILURE` — the moment any child returns `FAILURE` (remaining children are skipped).
 * - `RUNNING` — when a child returns `RUNNING` (sequence pauses and remembers that child).
 *
 * This "every step must succeed" pattern mirrors an `&&` chain, which is
 * why sequences are sometimes called *and-nodes*. They are the most common
 * composite for expressing multi-step procedures: check a condition, then
 * perform an action, then store a result.
 *
 * **Multi-step pipeline:**
 * ```ts
 * const processOrder = new SequenceNode({
 *   name: 'process-order',
 *   children: [
 *     validateOrder,   // Step 1: must pass before proceeding
 *     chargePayment,   // Step 2: must succeed before fulfilling
 *     fulfillOrder,    // Step 3: final action
 *   ],
 * });
 * ```
 *
 * **Condition gate + action (the most common pattern):**
 * ```ts
 * // The action only runs when the condition passes.
 * // If the condition returns FAILURE, the sequence short-circuits immediately.
 * const sendIfReady = new SequenceNode({
 *   name: 'send-if-ready',
 *   children: [isReady, sendMessage],
 * });
 * ```
 *
 * ## RUNNING and resumption
 *
 * When a child returns `RUNNING`, the sequence records that child's ID and
 * returns `RUNNING` itself. On the next tick the sequence resumes from that
 * child — skipping siblings that already succeeded — until the child resolves
 * to `SUCCESS` or `FAILURE`.
 *
 * Resumption is ID-based, not index-based, so it works correctly even when
 * an {@link ExecutionStrategy} reorders children between ticks.
 *
 * ## Strategy injection
 *
 * An optional {@link ExecutionStrategy} is called at the start of every tick
 * to determine child execution order. The default strategy preserves the
 * original insertion order. Use `AgentExecutionStrategy` to let Claude
 * dynamically sequence the steps based on the current blackboard state.
 *
 * ```ts
 * const adaptivePipeline = new SequenceNode({
 *   name: 'adaptive-pipeline',
 *   children: [fetchData, transformData, validateData, storeData],
 *   strategy: new AgentExecutionStrategy({
 *     prompt: 'Order these steps for optimal data processing',
 *     model: 'haiku',
 *     cache: true, // Decide once per reset cycle
 *   }),
 * });
 * ```
 */
export class SequenceNode extends BaseNode {
  private children: SequenceConfig['children'];
  private strategy: ExecutionStrategy;

  /**
   * The ID of the child that returned `RUNNING` on the previous tick.
   * `null` when no child is currently mid-execution.
   */
  private runningChildId: string | null = null;

  constructor(config: SequenceConfig) {
    super(config.name);
    this.children = config.children;
    this.strategy = config.strategy ?? new DefaultExecutionStrategy();
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // Ask the strategy for the execution order on every tick.
    // Agent strategies may change the order based on updated blackboard state,
    // unless they are configured with cache: true.
    const ordered = await this.strategy.order(this.children, context);

    // If a child was RUNNING on the previous tick, find it in the newly
    // ordered list by ID and resume from that position.
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
      if (status === NodeStatus.FAILURE) {
        this.runningChildId = null;
        return NodeStatus.FAILURE;
      }
      // SUCCESS: continue to the next child
    }

    this.runningChildId = null;
    return NodeStatus.SUCCESS;
  }

  /**
   * Reset this sequence and all of its children to their initial states.
   *
   * Clears the running-child record, calls `reset()` on the strategy
   * (if it implements one — agent strategies use this to clear cached
   * orderings), and cascades `reset()` to every child node.
   */
  reset(): void {
    this.runningChildId = null;
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
