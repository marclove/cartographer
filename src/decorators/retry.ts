import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { RetryConfig, TreeContext } from '../types.js';

export class RetryNode extends BaseNode {
  private child: RetryConfig['child'];
  private maxAttempts: number;
  private delayMs?: number;

  constructor(config: RetryConfig) {
    super(config.name);
    this.child = config.child;
    this.maxAttempts = config.maxAttempts;
    this.delayMs = config.delayMs;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const status = await this.child.tick(context);

      if (status !== NodeStatus.FAILURE) {
        return status;
      }

      if (attempt < this.maxAttempts - 1 && this.delayMs) {
        await new Promise((r) => setTimeout(r, this.delayMs));
      }
    }

    return NodeStatus.FAILURE;
  }

  reset(): void { this.child.reset(); }
  abort(): void { this.child.abort(); }
}
