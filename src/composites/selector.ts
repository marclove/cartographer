import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { SelectorConfig, TreeContext, SelectionStrategy } from '../types.js';
import { DefaultSelectionStrategy } from '../strategies/default-selection.js';

export class SelectorNode extends BaseNode {
  private children: SelectorConfig['children'];
  private strategy: SelectionStrategy;
  private runningChildId: string | null = null;

  constructor(config: SelectorConfig) {
    super(config.name);
    this.children = config.children;
    this.strategy = config.strategy ?? new DefaultSelectionStrategy();
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
      if (status === NodeStatus.SUCCESS) {
        this.runningChildId = null;
        return NodeStatus.SUCCESS;
      }
    }

    this.runningChildId = null;
    return NodeStatus.FAILURE;
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
