import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, DecoratorConfig, TreeContext } from '../types.js';
import { computeContentHash } from '../core/content-hash.js';

/**
 * A decorator that converts child FAILURE to RUNNING, creating an explicit
 * suspension point. SUCCESS and RUNNING pass through unchanged.
 *
 * Distinct from Repeat: Repeat loops internally within a single tick.
 * UntilSuccess returns RUNNING to the caller, allowing runToCompletion()
 * to detect the suspension via hasInflightWork() === false.
 */
export class UntilSuccess extends BaseNode {
  private child: BTreeNode;

  override get children(): readonly BTreeNode[] {
    return [this.child];
  }

  constructor(config: DecoratorConfig) {
    super(config.name, config.id);
    this.child = config.child;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const status = await this.child.tick(context);
    if (status === NodeStatus.FAILURE) {
      return NodeStatus.RUNNING; // suspension point
    }
    return status; // SUCCESS or RUNNING pass through
  }

  protected override computeHash(): string {
    return computeContentHash('UntilSuccess', this.child.contentHash());
  }

  reset(): void { this.child.reset(); }
  abort(): void { this.child.abort(); }
}

/** Factory function for creating an UntilSuccess decorator. */
export function untilSuccess(child: BTreeNode): UntilSuccess {
  return new UntilSuccess({ name: 'untilSuccess', child });
}
