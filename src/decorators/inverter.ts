import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { DecoratorConfig, TreeContext } from '../types.js';

export class InverterNode extends BaseNode {
  private child: DecoratorConfig['child'];

  constructor(config: DecoratorConfig) {
    super(config.name);
    this.child = config.child;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const status = await this.child.tick(context);
    if (status === NodeStatus.SUCCESS) return NodeStatus.FAILURE;
    if (status === NodeStatus.FAILURE) return NodeStatus.SUCCESS;
    return NodeStatus.RUNNING;
  }

  reset(): void { this.child.reset(); }
  abort(): void { this.child.abort(); }
}
