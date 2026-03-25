import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, RepeatConfig, TreeContext } from '../types.js';
import type { NodeState } from '../core/serialization.js';
import { computeContentHash } from '../core/content-hash.js';

/**
 * A decorator that ticks its child repeatedly within a single execution.
 *
 * On each call to `execute`, the child is ticked in a loop up to `count` times
 * (infinite if `count` is omitted). Two early-exit conditions interrupt the loop:
 *
 * - **RUNNING**: propagated immediately; the iteration counter is preserved so
 *   the loop resumes from the same position on the next tick.
 * - **`untilStatus` match**: if the child's result equals `untilStatus`, the loop
 *   stops and that status is returned. Use `untilStatus: NodeStatus.FAILURE` to
 *   build a "repeat until failure" pattern, or `NodeStatus.SUCCESS` to keep
 *   retrying until one attempt succeeds.
 *
 * If neither early-exit fires, the last status returned by the child is returned
 * after all iterations complete.
 */
export class Repeat extends BaseNode {
  private child: RepeatConfig['child'];
  private count?: number;
  private untilStatus?: NodeStatus;
  private _iteration = 0;

  override get children(): readonly BTreeNode[] {
    return [this.child];
  }

  protected override computeHash(): string {
    return computeContentHash('Repeat', String(this.count ?? ''), String(this.untilStatus ?? ''), this.child.contentHash());
  }

  override serialize(): NodeState {
    return { count: this._iteration };
  }

  override restore(state: NodeState, _hashToNode: Map<string, BTreeNode>): void {
    if (state.count !== undefined) {
      this._iteration = state.count;
    }
  }

  constructor(config: RepeatConfig) {
    super(config.name, config.id);
    this.child = config.child;
    this.count = config.count;
    this.untilStatus = config.untilStatus;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const limit = this.count ?? Infinity;
    let lastStatus = NodeStatus.SUCCESS;

    while (this._iteration < limit) {
      lastStatus = await this.child.tick(context);

      if (lastStatus === NodeStatus.RUNNING) {
        return NodeStatus.RUNNING;
      }

      if (this.untilStatus !== undefined && lastStatus === this.untilStatus) {
        this._iteration = 0;
        return lastStatus;
      }

      this._iteration++;
    }

    this._iteration = 0;
    return lastStatus;
  }

  reset(): void { this._iteration = 0; this.child.reset(); }
  abort(): void { this._iteration = 0; this.child.abort(); }
}
