import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { SequenceConfig, TreeContext, ExecutionStrategy } from '../types.js';
import { DefaultExecutionStrategy } from '../strategies/default-execution.js';

export class SequenceNode extends BaseNode {
  private children: SequenceConfig['children'];
  private strategy: ExecutionStrategy;

  constructor(config: SequenceConfig) {
    super(config.name);
    this.children = config.children;
    this.strategy = config.strategy ?? new DefaultExecutionStrategy();
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const ordered = await this.strategy.order(this.children, context);

    for (const child of ordered) {
      const status = await child.tick(context);
      if (status === NodeStatus.FAILURE || status === NodeStatus.RUNNING) {
        return status;
      }
    }

    return NodeStatus.SUCCESS;
  }

  reset(): void {
    for (const child of this.children) {
      child.reset();
    }
  }

  abort(): void {
    for (const child of this.children) {
      child.abort();
    }
  }
}
