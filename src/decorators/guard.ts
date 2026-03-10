import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, GuardConfig, TreeContext } from '../types.js';

/**
 * A decorator that gates its child behind an async condition function.
 *
 * On each tick the condition is evaluated first. If it returns `false`, or if it
 * throws, the node returns FAILURE immediately and the child is never ticked.
 * When the condition passes, the child's result is returned directly — including
 * RUNNING, so long-running children are fully supported.
 *
 * Common uses: permission checks before executing an action, resource availability
 * checks before starting an expensive subtree, or feature-flag gates that should
 * be re-evaluated on every tick.
 */
export class GuardNode extends BaseNode {
  private child: GuardConfig['child'];
  private condition: GuardConfig['condition'];

  override get children(): readonly BTreeNode[] {
    return [this.child];
  }

  constructor(config: GuardConfig) {
    super(config.name, config.id);
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
