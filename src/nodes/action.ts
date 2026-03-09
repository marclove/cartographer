import { BaseNode } from './base.js';
import type { ActionNodeConfig, TreeContext } from '../types.js';
import type { NodeStatus } from '../types.js';

export class ActionNode extends BaseNode {
  private action: ActionNodeConfig['action'];

  constructor(config: ActionNodeConfig) {
    super(config.name);
    this.action = config.action;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    return await this.action(context);
  }
}
