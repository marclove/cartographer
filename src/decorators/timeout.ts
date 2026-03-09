import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { TimeoutConfig, TreeContext } from '../types.js';

export class TimeoutNode extends BaseNode {
  private child: TimeoutConfig['child'];
  private timeoutMs: number;

  constructor(config: TimeoutConfig) {
    super(config.name);
    this.child = config.child;
    this.timeoutMs = config.timeoutMs;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    let timedOut = false;
    const timeoutPromise = new Promise<NodeStatus>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve(NodeStatus.FAILURE);
      }, this.timeoutMs);
    });

    const result = await Promise.race([this.child.tick(context), timeoutPromise]);

    if (timedOut) {
      this.child.abort();
    }

    return result;
  }

  reset(): void { this.child.reset(); }
  abort(): void { this.child.abort(); }
}
