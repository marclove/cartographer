import { BaseNode } from './base.js';
import type { ActionNodeConfig, TreeContext } from '../types.js';
import type { NodeStatus } from '../types.js';

/**
 * A leaf node that executes an arbitrary function when ticked.
 *
 * `ActionNode` is the most commonly used leaf node. It wraps any
 * synchronous or asynchronous function and returns the `NodeStatus` that
 * function produces. Use it for anything that *does* work: calling an API,
 * writing to the blackboard, sending a message, running a computation, etc.
 *
 * The action function receives the full {@link TreeContext}, giving it
 * access to the shared blackboard, the event emitter, and the abort signal.
 *
 * Exceptions thrown by the action are caught by `BaseNode.tick()` and
 * converted to `FAILURE` automatically — no try/catch needed unless you
 * want to distinguish between specific error types.
 *
 * **Simple action:**
 * ```ts
 * const greet = new ActionNode({
 *   name: 'greet',
 *   action: async () => {
 *     console.log('Hello!');
 *     return NodeStatus.SUCCESS;
 *   },
 * });
 * ```
 *
 * **Reading from and writing to the blackboard:**
 * ```ts
 * const enrichUser = new ActionNode({
 *   name: 'enrich-user',
 *   action: async (context) => {
 *     const userId = context.blackboard.get<string>('userId');
 *     if (!userId) return NodeStatus.FAILURE;
 *
 *     const profile = await fetchProfile(userId);
 *     context.blackboard.set('userProfile', profile);
 *     return NodeStatus.SUCCESS;
 *   },
 * });
 * ```
 *
 * **Returning RUNNING for multi-tick work:**
 * ```ts
 * let uploaded = false;
 *
 * const upload = new ActionNode({
 *   name: 'upload-file',
 *   action: async (context) => {
 *     if (!uploaded) {
 *       startBackgroundUpload(); // fire and forget
 *       uploaded = true;
 *       return NodeStatus.RUNNING; // not done yet
 *     }
 *     return isUploadComplete() ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
 *   },
 * });
 * ```
 *
 * **Checking the abort signal:**
 * ```ts
 * const processItems = new ActionNode({
 *   name: 'process-items',
 *   action: async (context) => {
 *     const items = context.blackboard.get<string[]>('items') ?? [];
 *     for (const item of items) {
 *       if (context.signal?.aborted) return NodeStatus.FAILURE;
 *       await processItem(item);
 *     }
 *     return NodeStatus.SUCCESS;
 *   },
 * });
 * ```
 */
export class ActionNode extends BaseNode {
  private action: ActionNodeConfig['action'];

  constructor(config: ActionNodeConfig) {
    super(config.name, config.id);
    this.action = config.action;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    return await this.action(context);
  }
}
