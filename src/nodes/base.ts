import { v4 as uuidv4 } from 'uuid';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';

/**
 * Abstract base class that all behavior tree nodes extend.
 *
 * `BaseNode` implements the {@link BTreeNode} interface and handles the
 * cross-cutting concerns that every node shares:
 *
 * - **Identity** — Assigns a unique UUID to each node instance.
 * - **Event emission** — Fires `node:enter`, `node:exit`, and `node:error`
 *   events around every tick for observability.
 * - **Timing** — Measures execution duration and includes it in `node:exit`.
 * - **Error containment** — Catches any exception thrown by {@link execute},
 *   emits `node:error`, and returns `FAILURE` instead of propagating the
 *   exception. This prevents one misbehaving node from crashing the whole tree.
 *
 * Subclasses only need to implement the single abstract method
 * {@link execute}. Optionally override {@link reset} and/or {@link abort}
 * if the subclass holds state or in-progress work.
 *
 * @example Implementing a custom leaf node
 * ```ts
 * class PingNode extends BaseNode {
 *   constructor() {
 *     super('ping');
 *   }
 *
 *   protected async execute(context: TreeContext): Promise<NodeStatus> {
 *     const ok = await ping(context.blackboard.get<string>('host'));
 *     return ok ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
 *   }
 * }
 * ```
 */
export abstract class BaseNode implements BTreeNode {
  /**
   * A UUID v4 that uniquely identifies this node instance.
   *
   * Generated at construction time. Useful for correlating events across
   * a tick when multiple nodes share the same `name`.
   */
  readonly id: string;

  /**
   * The human-readable name supplied at construction.
   *
   * Included in every `node:enter`, `node:exit`, and `node:error` event
   * payload. Should be unique within a tree to make event logs readable,
   * though uniqueness is not enforced.
   */
  readonly name: string;

  /**
   * Optional context overrides for this node and its descendants.
   *
   * When set, these fields are shallow-merged onto the incoming `TreeContext`
   * in `tick()` before calling `execute()`. Children receive the merged
   * context, and their own overrides layer on top — closest override wins,
   * like React Context providers.
   *
   * `events` and `blackboard` are never overridable. The tree-level event
   * emitter is always preserved to guarantee a single observability point.
   * The tree-level blackboard is always preserved as the single shared data
   * store (per-subtree scoping is a future feature requiring a different
   * mechanism).
   */
  protected _inflightState: {
    promise: Promise<NodeStatus>;
    result?: NodeStatus;
    error?: Error;
  } | null = null;

  protected contextOverrides?: Partial<TreeContext>;

  /**
   * The direct children of this node.
   *
   * Returns an empty array by default (leaf nodes). Composites and
   * decorators override this to expose their children for tree walking.
   */
  get children(): readonly BTreeNode[] {
    return [];
  }

  constructor(name: string, id?: string) {
    this.id = id ?? uuidv4();
    this.name = name;
  }

  /**
   * Set context overrides for this node and its descendants.
   * Fields set here will be shallow-merged onto the incoming TreeContext
   * before this node's execute() and before passing context to children.
   *
   * Note: `events` and `blackboard` are never overridable. The tree-level
   * event emitter is always preserved to guarantee a single observability
   * point. The tree-level blackboard is always preserved as the single
   * shared data store (per-subtree scoping is a future feature requiring
   * a different mechanism).
   */
  setContextOverrides(overrides: Partial<TreeContext>): void {
    this.contextOverrides = overrides;
  }

  /**
   * Merge additional context overrides onto any existing overrides.
   */
  mergeContextOverrides(overrides: Partial<TreeContext>): void {
    this.contextOverrides = { ...this.contextOverrides, ...overrides };
  }

  /**
   * Execute one tick of this node.
   *
   * This method should not be overridden by subclasses — implement
   * {@link execute} instead. `tick()` handles all the surrounding
   * infrastructure:
   *
   * 1. Emits `node:enter` on the context event emitter.
   * 2. Records the start time.
   * 3. Calls the subclass's `execute()` implementation.
   * 4. On success: emits `node:exit` with the returned status and elapsed time.
   * 5. On error: emits `node:error` with the caught exception, then emits
   *    `node:exit` with `FAILURE` and elapsed time. The exception is **not**
   *    re-thrown — the node returns `FAILURE` instead.
   *
   * @returns The status returned by `execute()`, or `FAILURE` if `execute()`
   *   threw an exception.
   */
  async tick(context: TreeContext): Promise<NodeStatus> {
    const effectiveContext = this.contextOverrides
      ? { ...context, ...this.contextOverrides, events: context.events, blackboard: context.blackboard }
      : context;

    effectiveContext.events.emit('node:enter', { node: this, context: effectiveContext });
    const start = performance.now();

    try {
      const status = await this.execute(effectiveContext);
      const durationMs = performance.now() - start;
      effectiveContext.events.emit('node:exit', { node: this, status, context: effectiveContext, durationMs });
      return status;
    } catch (error) {
      const durationMs = performance.now() - start;
      effectiveContext.events.emit('node:error', { node: this, error: error as Error, context: effectiveContext });
      effectiveContext.events.emit('node:exit', {
        node: this,
        status: NodeStatus.FAILURE,
        context: effectiveContext,
        durationMs,
      });
      return NodeStatus.FAILURE;
    }
  }

  /**
   * Reset this node to its initial state.
   *
   * The base implementation is a no-op. Subclasses that hold internal
   * state — such as a current child index, attempt counters, or a cached
   * agent result — should override this method to clear that state.
   *
   * `reset()` is called by `BehaviorTree.reset()`, which cascades the call
   * through all nodes in the tree.
   */
  reset(): void {
    // Subclasses override if they have state to reset
  }

  /**
   * Signal this node to abort any in-progress work.
   *
   * The base implementation is a no-op. Subclasses that launch async
   * operations — such as composites that need to abort running children —
   * should override this method to cancel those operations.
   *
   * `abort()` is called by `BehaviorTree.abort()`, which cascades the call
   * through all nodes in the tree. The tree's `AbortSignal` (available via
   * `context.signal`) is also triggered at the same time, so long-running
   * nodes can check `context.signal?.aborted` to stop cooperatively.
   */
  abort(): void {
    // Subclasses override if they have in-progress work to cancel
  }

  hasInflightWork(): boolean {
    if (!this._inflightState) return false;
    return this._inflightState.result === undefined && this._inflightState.error === undefined;
  }

  inflightPromise(): Promise<void> | null {
    if (!this.hasInflightWork()) return null;
    return this._inflightState!.promise.then(() => {});
  }

  /**
   * The node-specific logic to run on each tick.
   *
   * This is the single method that every concrete node must implement.
   * It receives the shared {@link TreeContext} and returns one of:
   *
   * - `NodeStatus.SUCCESS` — The node's work is complete and succeeded.
   * - `NodeStatus.FAILURE` — The node's work failed or its condition was not met.
   * - `NodeStatus.RUNNING` — The node is still in progress; `tick()` will be
   *   called again on the next tree tick to continue.
   *
   * Exceptions thrown from `execute()` are caught by {@link tick} and
   * converted to `FAILURE` automatically, so there is no need to wrap
   * logic in try/catch unless you need to handle specific error cases.
   *
   * @param context - The execution context carrying the blackboard, event
   *   emitter, and optional abort signal.
   */
  protected abstract execute(context: TreeContext): Promise<NodeStatus>;
}
