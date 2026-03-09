import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { SequenceConfig, TreeContext, ExecutionStrategy } from '../types.js';
import { DefaultExecutionStrategy } from '../strategies/default-execution.js';

export class SequenceNode extends BaseNode {
  private children: SequenceConfig['children'];
  private strategy: ExecutionStrategy;
  private runningChildId: string | null = null;

  constructor(config: SequenceConfig) {
    super(config.name);
    this.children = config.children;
    this.strategy = config.strategy ?? new DefaultExecutionStrategy();
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const ordered = await this.strategy.order(this.children, context);

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
    }

    this.runningChildId = null;
    return NodeStatus.SUCCESS;
  }

  reset(): void {
    this.runningChildId = null;
    this.strategy.reset?.();
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
