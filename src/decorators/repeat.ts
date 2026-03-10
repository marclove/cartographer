import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, RepeatConfig, TreeContext } from '../types.js';

/**
 * A decorator that ticks its child repeatedly within a single execution.
 *
 * On each call to `execute`, the child is ticked in a synchronous loop up to
 * `count` times (infinite if `count` is omitted). Two early-exit conditions
 * interrupt the loop:
 *
 * - **RUNNING**: propagated immediately; the loop resets on the next tick, so
 *   `count` reflects the number of completions per tick, not across the node's
 *   lifetime.
 * - **`untilStatus` match**: if the child's result equals `untilStatus`, the loop
 *   stops and that status is returned. Use `untilStatus: NodeStatus.FAILURE` to
 *   build a "repeat until failure" pattern, or `NodeStatus.SUCCESS` to keep
 *   retrying until one attempt succeeds.
 *
 * If neither early-exit fires, the last status returned by the child is returned
 * after all iterations complete.
 */
export class RepeatNode extends BaseNode {
  private child: RepeatConfig['child'];
  private count?: number;
  private untilStatus?: NodeStatus;

  override get children(): readonly BTreeNode[] {
    return [this.child];
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

    for (let i = 0; i < limit; i++) {
      lastStatus = await this.child.tick(context);

      if (lastStatus === NodeStatus.RUNNING) {
        return NodeStatus.RUNNING;
      }

      if (this.untilStatus !== undefined && lastStatus === this.untilStatus) {
        return lastStatus;
      }
    }

    return lastStatus;
  }

  reset(): void { this.child.reset(); }
  abort(): void { this.child.abort(); }
}
