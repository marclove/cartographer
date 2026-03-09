import { BaseNode } from './base.js';
import { NodeStatus } from '../types.js';
import type { ConditionNodeConfig, TreeContext } from '../types.js';

export class ConditionNode extends BaseNode {
  private condition: ConditionNodeConfig['condition'];

  constructor(config: ConditionNodeConfig) {
    super(config.name);
    this.condition = config.condition;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const result = await this.condition(context);
    return result ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}
