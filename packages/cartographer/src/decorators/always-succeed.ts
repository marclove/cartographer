import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, DecoratorConfig, TreeContext } from '../types.js';
import { computeContentHash } from '../core/content-hash.js';

/**
 * A decorator that forces its child to always return SUCCESS.
 *
 * Executes the child node normally but replaces any FAILURE result with SUCCESS.
 * RUNNING is passed through unchanged, so the child can still span multiple ticks
 * before producing its (overridden) result.
 *
 * Common uses: making an optional step in a Sequence non-blocking (the sequence
 * continues even if the step fails), or suppressing expected errors from cleanup
 * actions that may or may not have work to do.
 */
export class AlwaysSucceedNode extends BaseNode {
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
    if (status === NodeStatus.RUNNING) return NodeStatus.RUNNING;
    return NodeStatus.SUCCESS;
  }

  protected override computeHash(): string {
    return computeContentHash('AlwaysSucceedNode', this.child.contentHash());
  }

  reset(): void { this.child.reset(); }
  abort(): void { this.child.abort(); }
}
