import { BaseNode } from './base.js';
import type { ActionNodeConfig, TreeContext } from '../types.js';
import { NodeStatus } from '../types.js';
import type { NodeState } from '../core/serialization.js';

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
  private _lastTerminalStatus: NodeStatus | null = null;

  constructor(config: ActionNodeConfig) {
    super(config.name, config.id);
    this.action = config.action;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // Poll: inflight work has completed with a result
    if (this._inflightState?.result !== undefined) {
      const result = this._inflightState.result;
      this._inflightState = null;
      if (result !== NodeStatus.RUNNING) {
        this._lastTerminalStatus = result;
      }
      return result;
    }

    // Poll: inflight work has completed with an error
    if (this._inflightState?.error !== undefined) {
      const error = this._inflightState.error;
      this._inflightState = null;
      throw error;
    }

    // Poll: inflight work is still pending
    if (this._inflightState) {
      return NodeStatus.RUNNING;
    }

    // Start: call the action function.
    const resultOrPromise = this.action(context);

    // Fast path: synchronous actions return their result in a single tick.
    // This avoids the inflight pattern (and its two-tick overhead) for
    // actions that don't need it, and prevents the message processor's
    // suspension detection from falsely triggering between consecutive
    // synchronous action nodes.
    if (!(resultOrPromise instanceof Promise)) {
      if (resultOrPromise !== NodeStatus.RUNNING) {
        this._lastTerminalStatus = resultOrPromise;
      }
      return resultOrPromise;
    }

    // Async path: the action returned a Promise — use the inflight pattern
    // so the tree can yield and resume on the next tick.
    const promise = resultOrPromise;
    const state: { promise: Promise<NodeStatus>; result?: NodeStatus; error?: Error } = { promise };
    this._inflightState = state;

    promise.then(
      (result) => { state.result = result; },
      (error) => { state.error = error instanceof Error ? error : new Error(String(error)); },
    );

    return NodeStatus.RUNNING;
  }

  override serialize(): NodeState {
    return this._lastTerminalStatus !== null
      ? { lastStatus: this._lastTerminalStatus }
      : {};
  }

  override restore(state: NodeState, _hashToNode: Map<string, import('../types.js').BTreeNode>): void {
    if (state.lastStatus !== undefined) {
      this._lastTerminalStatus = state.lastStatus;
    }
  }

  override abort(): void {
    this._inflightState = null;
  }

  override reset(): void {
    super.reset();
    this._inflightState = null;
  }
}
