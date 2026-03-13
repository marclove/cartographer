import { BaseNode } from '../nodes/base.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, RetryConfig, TreeContext } from '../types.js';

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
 * The attempt counter is persisted as an instance field so it survives across
 * ticks when a child returns RUNNING. When the child completes (non-FAILURE or
 * all attempts exhausted), the counter resets to zero.
 *
 * Common uses: transient network calls that may fail intermittently, LLM
 * requests where an occasional error is expected, or any action where a brief
 * back-off before retrying is appropriate.
 */
export class RetryNode extends BaseNode {
  private child: RetryConfig['child'];
  private maxAttempts: number;
  private delayMs?: number;
  private _attempt = 0;

  override get children(): readonly BTreeNode[] {
    return [this.child];
  }

  constructor(config: RetryConfig) {
    super(config.name, config.id);
    this.child = config.child;
    this.maxAttempts = config.maxAttempts;
    this.delayMs = config.delayMs;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    while (this._attempt < this.maxAttempts) {
      const status = await this.child.tick(context);

      if (status === NodeStatus.RUNNING) {
        return NodeStatus.RUNNING;
      }

      if (status !== NodeStatus.FAILURE) {
        this._attempt = 0;
        return status;
      }

      this._attempt++;

      // Don't delay after the final attempt or when about to return
      if (this._attempt < this.maxAttempts && this.delayMs) {
        await new Promise((r) => setTimeout(r, this.delayMs));
      }
    }

    this._attempt = 0;
    return NodeStatus.FAILURE;
  }

  reset(): void { this._attempt = 0; this.child.reset(); }
  abort(): void { this.child.abort(); }
}
