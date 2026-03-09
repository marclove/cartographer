import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { GuardConfig, TreeContext } from '../types.js';

export class GuardNode extends BaseNode {
  private child: GuardConfig['child'];
  private condition: GuardConfig['condition'];

  constructor(config: GuardConfig) {
    super(config.name);
    this.child = config.child;
    this.condition = config.condition;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    try {
      const allowed = await this.condition(context);
      if (!allowed) {
        return NodeStatus.FAILURE;
      }
    } catch {
      return NodeStatus.FAILURE;
    }

    return this.child.tick(context);
  }

  reset(): void { this.child.reset(); }
  abort(): void { this.child.abort(); }
}
