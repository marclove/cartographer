import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { RepeatConfig, TreeContext } from '../types.js';

export class RepeatNode extends BaseNode {
  private child: RepeatConfig['child'];
  private count?: number;
  private untilStatus?: NodeStatus;

  constructor(config: RepeatConfig) {
    super(config.name);
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
