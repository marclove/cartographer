import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { RetryConfig, TreeContext } from '../types.js';

/**
 * A decorator that re-ticks its child up to `maxAttempts` times until it stops
 * returning FAILURE.
 *
 * On each attempt the child is ticked. Any result other than FAILURE — i.e.
 * SUCCESS or RUNNING — is returned immediately and the retry loop stops. On
 * FAILURE, an optional `delayMs` pause is inserted before the next attempt
 * (the delay is skipped after the final attempt). If every attempt fails,
 * FAILURE is returned.
 *
 * Like `RepeatNode`, the attempt counter is local to a single `execute` call.
 * If the child returns RUNNING, the node surfaces that status and the full
 * attempt sequence restarts from zero on the next tick.
 *
 * Common uses: transient network calls that may fail intermittently, LLM
 * requests where an occasional error is expected, or any action where a brief
 * back-off before retrying is appropriate.
 */
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
