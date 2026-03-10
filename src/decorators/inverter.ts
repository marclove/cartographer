import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, DecoratorConfig, TreeContext } from '../types.js';

/**
 * A decorator that flips its child's terminal result: SUCCESS becomes FAILURE
 * and FAILURE becomes SUCCESS. RUNNING is passed through unchanged.
 *
 * Common uses: turning a condition node into its logical negation (e.g. "is NOT
 * ready"), or making a Selector branch that should only be taken when a subtree
 * fails behave as a success path instead.
 */
export class InverterNode extends BaseNode {
  private child: DecoratorConfig['child'];

  override get children(): readonly BTreeNode[] {
    return [this.child];
  }

  constructor(config: DecoratorConfig) {
    super(config.name, config.id);
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
