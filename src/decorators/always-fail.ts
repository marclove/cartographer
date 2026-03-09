import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { DecoratorConfig, TreeContext } from '../types.js';

/**
 * A decorator that forces its child to always return FAILURE.
 *
 * Executes the child node normally but replaces any SUCCESS result with FAILURE.
 * RUNNING is passed through unchanged, so the child can still span multiple ticks
 * before producing its (overridden) result.
 *
 * Common uses: forcing a branch to fail for testing purposes, or guaranteeing
 * that a Selector continues past a child that would otherwise short-circuit it.
 */
export class AlwaysFailNode extends BaseNode {
  private child: DecoratorConfig['child'];

  constructor(config: DecoratorConfig) {
    super(config.name);
    this.child = config.child;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const status = await this.child.tick(context);
    if (status === NodeStatus.RUNNING) return NodeStatus.RUNNING;
    return NodeStatus.FAILURE;
  }

  reset(): void { this.child.reset(); }
  abort(): void { this.child.abort(); }
}
