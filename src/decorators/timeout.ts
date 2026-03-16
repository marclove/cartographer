import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TimeoutConfig, TreeContext } from '../types.js';
import { computeContentHash } from '../core/content-hash.js';

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

  /** Whether the background timer has fired, aborting the child. */
  private _timedOut = false;

  /** Handle for the background setTimeout so it can be cleared. */
  private _timer: ReturnType<typeof setTimeout> | null = null;

  override get children(): readonly BTreeNode[] {
    return [this.child];
  }

  protected override computeHash(): string {
    return computeContentHash('TimeoutNode', String(this.timeoutMs), this.child.contentHash());
  }

  constructor(config: TimeoutConfig) {
    super(config.name, config.id);
    this.child = config.child;
    this.timeoutMs = config.timeoutMs;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // Background timer already fired — return FAILURE without re-ticking
    if (this._timedOut) {
      this.clearTimeout();
      return NodeStatus.FAILURE;
    }

    // Check timeout before ticking child (poll-based path for frequent ticks)
    if (this._startTime !== null && Date.now() - this._startTime > this.timeoutMs) {
      this.child.abort();
      this.clearTimeout();
      return NodeStatus.FAILURE;
    }

    const status = await this.child.tick(context);

    if (status === NodeStatus.RUNNING) {
      // Record start time and start background timer on first RUNNING tick
      if (this._startTime === null) {
        this._startTime = Date.now();
        this._timer = setTimeout(() => {
          this._timedOut = true;
          this.child.abort();
        }, this.timeoutMs);
      }
      return NodeStatus.RUNNING;
    }

    // Child completed (SUCCESS or FAILURE) — clear timer
    this.clearTimeout();
    return status;
  }

  private clearTimeout(): void {
    this._startTime = null;
    this._timedOut = false;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  reset(): void {
    this.clearTimeout();
    this.child.reset();
  }

  abort(): void {
    this.clearTimeout();
    this.child.abort();
  }

  override interrupt(): void {
    this.clearTimeout();
    this.child.interrupt();
  }
}
