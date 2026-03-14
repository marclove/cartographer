import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, GuardConfig, TreeContext } from '../types.js';

/**
 * A decorator that gates its child behind a condition function.
 *
 * On each tick the condition is evaluated first. If it returns `false`, or if it
 * throws, the node returns FAILURE immediately and the child is never ticked.
 * When the condition passes, the child's result is returned directly — including
 * RUNNING, so long-running children are fully supported.
 *
 * ## Async conditions and the inflight pattern
 *
 * Condition functions may return `boolean` or `Promise<boolean>`. Synchronous
 * conditions resolve in a single tick with no overhead. Async conditions use
 * the same inflight pattern as ActionNode: the promise is started on the first
 * tick and RUNNING is returned immediately. Subsequent ticks poll for the
 * result. This keeps ticks non-blocking so the reactive model can re-evaluate
 * other branches while the condition is pending.
 *
 * Common uses: permission checks before executing an action, resource availability
 * checks before starting an expensive subtree, or feature-flag gates that should
 * be re-evaluated on every tick.
 */
export class GuardNode extends BaseNode {
  private child: GuardConfig['child'];
  private condition: GuardConfig['condition'];

  /**
   * Inflight state for an async condition evaluation.
   * Null when no condition is pending. Set when a condition returns a Promise
   * that hasn't resolved yet. Cleared on resolution, abort, or reset.
   */
  private _conditionInflight: {
    promise: Promise<boolean>;
    result?: boolean;
    error?: Error;
  } | null = null;

  override get children(): readonly BTreeNode[] {
    return [this.child];
  }

  constructor(config: GuardConfig) {
    super(config.name, config.id);
    this.child = config.child;
    this.condition = config.condition;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // Poll: inflight condition resolved with a result
    if (this._conditionInflight?.result !== undefined) {
      const allowed = this._conditionInflight.result;
      this._conditionInflight = null;
      if (!allowed) {
        this.child.abort();
        return NodeStatus.FAILURE;
      }
      return this.child.tick(context);
    }

    // Poll: inflight condition rejected with an error
    if (this._conditionInflight?.error !== undefined) {
      this._conditionInflight = null;
      this.child.abort();
      return NodeStatus.FAILURE;
    }

    // Poll: inflight condition still pending
    if (this._conditionInflight) {
      return NodeStatus.RUNNING;
    }

    // Start: evaluate the condition
    let conditionResult: boolean | Promise<boolean>;
    try {
      conditionResult = this.condition(context);
    } catch {
      this.child.abort();
      return NodeStatus.FAILURE;
    }

    // Fast path: synchronous condition resolved immediately
    if (typeof conditionResult === 'boolean') {
      if (!conditionResult) {
        this.child.abort();
        return NodeStatus.FAILURE;
      }
      return this.child.tick(context);
    }

    // Async path: start inflight tracking, return RUNNING
    const state: { promise: Promise<boolean>; result?: boolean; error?: Error } = {
      promise: conditionResult,
    };
    this._conditionInflight = state;

    conditionResult.then(
      (result) => { state.result = result; },
      (error) => { state.error = error instanceof Error ? error : new Error(String(error)); },
    );

    return NodeStatus.RUNNING;
  }

  reset(): void {
    this._conditionInflight = null;
    this.child.reset();
  }

  abort(): void {
    this._conditionInflight = null;
    this.child.abort();
  }
}
