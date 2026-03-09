import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { TimeoutConfig, TreeContext } from '../types.js';

/**
 * A decorator that enforces a wall-clock deadline on its child.
 *
 * On each tick, the child is raced against a `timeoutMs` timer using
 * `Promise.race`. If the child completes first, its result is returned
 * unchanged and the timer is cancelled. If the timer fires first, `abort()`
 * is called on the child and FAILURE is returned.
 *
 * The deadline is measured per tick — a fresh timer is started on every call
 * to `execute`. A child that returns RUNNING will therefore be given a full
 * `timeoutMs` window on each subsequent tick.
 *
 * Common uses: capping the wall time of an `AgentNode` LLM call, bounding a
 * network action, or preventing a stuck subtree from blocking the tree
 * indefinitely.
 */
export class TimeoutNode extends BaseNode {
  private child: TimeoutConfig['child'];
  private timeoutMs: number;

  constructor(config: TimeoutConfig) {
    super(config.name);
    this.child = config.child;
    this.timeoutMs = config.timeoutMs;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    let timedOut = false;
    let timerId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<NodeStatus>((resolve) => {
      timerId = setTimeout(() => {
        timedOut = true;
        resolve(NodeStatus.FAILURE);
      }, this.timeoutMs);
    });

    const result = await Promise.race([this.child.tick(context), timeoutPromise]);
    clearTimeout(timerId!);

    if (timedOut) {
      this.child.abort();
    }

    return result;
  }

  reset(): void { this.child.reset(); }
  abort(): void { this.child.abort(); }
}
