import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { ParallelConfig, TreeContext, ParallelStrategy } from '../types.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';

export class ParallelNode extends BaseNode {
  private children: ParallelConfig['children'];
  private strategy: ParallelStrategy;

  constructor(config: ParallelConfig) {
    super(config.name);
    this.children = config.children;
    this.strategy = config.strategy ?? new DefaultParallelStrategy();
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const policy = await this.strategy.policy(this.children, context);
    const results = await Promise.all(this.children.map((child) => child.tick(context)));

    if (results.includes(NodeStatus.RUNNING)) {
      return NodeStatus.RUNNING;
    }

    const successCount = results.filter((r) => r === NodeStatus.SUCCESS).length;
    const failureCount = results.filter((r) => r === NodeStatus.FAILURE).length;

    if (policy.failureCount !== undefined && failureCount >= policy.failureCount) {
      return NodeStatus.FAILURE;
    }

    if (policy.successPercentage !== undefined) {
      const percentage = (successCount / results.length) * 100;
      return percentage >= policy.successPercentage ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
    }

    if (policy.successCount !== undefined) {
      return successCount >= policy.successCount ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
    }

    return failureCount === 0 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
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
