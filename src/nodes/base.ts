import { v4 as uuidv4 } from 'uuid';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';

export abstract class BaseNode implements BTreeNode {
  readonly id: string;
  readonly name: string;

  constructor(name: string) {
    this.id = uuidv4();
    this.name = name;
  }

  async tick(context: TreeContext): Promise<NodeStatus> {
    context.events.emit('node:enter', { node: this, context });
    const start = performance.now();

    try {
      const status = await this.execute(context);
      const durationMs = performance.now() - start;
      context.events.emit('node:exit', { node: this, status, context, durationMs });
      return status;
    } catch (error) {
      const durationMs = performance.now() - start;
      context.events.emit('node:error', { node: this, error: error as Error, context });
      context.events.emit('node:exit', {
        node: this,
        status: NodeStatus.FAILURE,
        context,
        durationMs,
      });
      return NodeStatus.FAILURE;
    }
  }

  reset(): void {
    // Subclasses override if they have state to reset
  }

  abort(): void {
    // Subclasses override if they have in-progress work to cancel
  }

  protected abstract execute(context: TreeContext): Promise<NodeStatus>;
}
