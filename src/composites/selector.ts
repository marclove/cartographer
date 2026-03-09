import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { SelectorConfig, TreeContext, SelectionStrategy } from '../types.js';
import { DefaultSelectionStrategy } from '../strategies/default-selection.js';

export class SelectorNode extends BaseNode {
  private children: SelectorConfig['children'];
  private strategy: SelectionStrategy;

  constructor(config: SelectorConfig) {
    super(config.name);
    this.children = config.children;
    this.strategy = config.strategy ?? new DefaultSelectionStrategy();
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const ordered = await this.strategy.order(this.children, context);

    for (const child of ordered) {
      const status = await child.tick(context);
      if (status === NodeStatus.SUCCESS || status === NodeStatus.RUNNING) {
        return status;
      }
    }

    return NodeStatus.FAILURE;
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
