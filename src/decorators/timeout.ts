import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TimeoutConfig, TreeContext } from '../types.js';

/**
 * A decorator that enforces a wall-clock deadline on its child across ticks.
 *
 * On the first tick where the child returns RUNNING, the node records the
 * current wall-clock time. On each subsequent tick, it checks whether the
 * elapsed time exceeds `timeoutMs`. If it has, the child is aborted and
 * FAILURE is returned — without ticking the child again.
 *
 * If the child completes (SUCCESS or FAILURE) before the deadline, its
 * result is returned and the internal timer is cleared so the next
 * activation cycle gets a fresh timeout window.
 *
 * `reset()` and `abort()` both clear the recorded start time.
 *
 * Common uses: capping the wall time of an `AgentNode` LLM call, bounding a
 * network action, or preventing a stuck subtree from blocking the tree
 * indefinitely.
 */
export class TimeoutNode extends BaseNode {
  private child: TimeoutConfig['child'];
  private timeoutMs: number;
  private _startTime: number | null = null;

  override get children(): readonly BTreeNode[] {
    return [this.child];
  }

  constructor(config: TimeoutConfig) {
    super(config.name, config.id);
    this.child = config.child;
    this.timeoutMs = config.timeoutMs;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // Check timeout before ticking child
    if (this._startTime !== null && Date.now() - this._startTime > this.timeoutMs) {
      this.child.abort();
      this._startTime = null;
      return NodeStatus.FAILURE;
    }

    const status = await this.child.tick(context);

    if (status === NodeStatus.RUNNING) {
      // Record start time on first RUNNING tick
      if (this._startTime === null) {
        this._startTime = Date.now();
      }
      return NodeStatus.RUNNING;
    }

    // Child completed (SUCCESS or FAILURE) — clear timer
    this._startTime = null;
    return status;
  }

  reset(): void {
    this._startTime = null;
    this.child.reset();
  }

  abort(): void {
    this._startTime = null;
    this.child.abort();
  }
}
