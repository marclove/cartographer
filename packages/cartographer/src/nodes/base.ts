import { v4 as uuidv4 } from 'uuid';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';
import type { NodeState } from '../core/serialization.js';
import { computeContentHash } from '../core/content-hash.js';

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
 * **If your node does async work**, you must route it through
 * {@link _inflightState} so the tree runner can wait for it, detect
 * suspension, and support interrupts. See {@link _inflightState} for the
 * full contract and {@link ActionNode} for a reference implementation.
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
  private _contentHash: string | null = null;

  /**
   * Tracks in-flight async work launched by this node.
   *
   * This field is the mechanism that connects individual nodes to the tree
   * runner's tick loop, interrupt system, and suspension detection. When a
   * node launches async work (e.g., an API call), it stores the promise and
   * its eventual result or error here. The tree runner then uses
   * {@link hasInflightWork}, {@link inflightPromise}, and {@link interrupt}
   * — all of which read `_inflightState` — to decide whether to wait, race
   * against an interrupt signal, or treat the tree as suspended.
   *
   * **How it works:**
   *
   * 1. In `execute()`, launch your async work and store the promise:
   *    ```ts
   *    const promise = doAsyncWork();
   *    this._inflightState = { promise };
   *    promise.then(
   *      (result) => { this._inflightState!.result = result; },
   *      (error) => { this._inflightState!.error = error; },
   *    );
   *    return NodeStatus.RUNNING;
   *    ```
   *
   * 2. On subsequent ticks, poll `_inflightState` for a result or error:
   *    ```ts
   *    if (this._inflightState?.result !== undefined) {
   *      const result = this._inflightState.result;
   *      this._inflightState = null;
   *      return result;
   *    }
   *    ```
   *
   * 3. The tree runner calls `hasInflightWork()` after each tick. If any
   *    node has an unsettled `_inflightState`, the runner waits (via
   *    `settled()`) for it to resolve before ticking again. If no node has
   *    inflight work for two consecutive ticks, the runner treats the tree
   *    as *suspended* and stops ticking.
   *
   * **Why this matters for custom nodes:** If your node returns `RUNNING`
   * but does **not** set `_inflightState`, the tree runner has no promise
   * to wait on. After two consecutive ticks with `RUNNING` and no inflight
   * work, the runner will conclude the tree is suspended and stop ticking
   * — even if your node has real work happening externally. To avoid this,
   * always route async work through `_inflightState`. See {@link ActionNode}
   * for the reference implementation of this pattern.
   *
   * The field is `null` when no work is in flight.
   *
   * @see {@link hasInflightWork} — reads this field to report inflight status.
   * @see {@link inflightPromise} — exposes the promise for `BehaviorTree.settled()`.
   * @see {@link interrupt} — clears unsettled `_inflightState` on interrupt.
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

  /**
   * Create a new node with the given name and optional stable identifier.
   *
   * @param name - A human-readable label for this node, included in all
   *   emitted events (`node:enter`, `node:exit`, `node:error`).
   * @param id - An optional stable identifier. When omitted, a UUID v4 is
   *   generated automatically. Supply a deterministic ID when you need
   *   stable cross-run log correlation or config-driven identity. Must
   *   be unique across all nodes in a tree — `BehaviorTree` validates
   *   this at construction time and throws on duplicates.
   */
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

  /**
   * Cancel unsettled in-flight work without destroying cycle state.
   *
   * Unlike {@link abort}, `interrupt()` preserves composite cycle state
   * (`completedMap`, `committedOrder`) so that children which have already
   * completed are not re-executed. The tree remains tickable immediately
   * after an interrupt — no {@link reset} call is needed.
   *
   * The base implementation clears this node's `_inflightState` if its
   * promise has not yet settled, then recurses into all {@link children}.
   * Composites may override to add node-specific cleanup while still
   * preserving their cycle progress.
   */
  interrupt(): void {
    // Clear unsettled inflight work without destroying cycle state.
    // Composites override to recurse into children without calling clearCycle().
    if (this._inflightState && this._inflightState.result === undefined && this._inflightState.error === undefined) {
      this._inflightState = null;
    }
    for (const child of this.children) {
      child.interrupt();
    }
  }

  /**
   * Check whether this node or any of its descendants have unsettled
   * in-flight async work.
   *
   * Returns `true` if this node's `_inflightState` promise has not yet
   * resolved or rejected, or if any child reports in-flight work.
   * Used by the tree runner to decide whether to wait for pending work
   * before taking the next action (e.g., serializing state or processing
   * a new message).
   */
  hasInflightWork(): boolean {
    if (this._inflightState && this._inflightState.result === undefined && this._inflightState.error === undefined) {
      return true;
    }
    return this.children.some(child => child.hasInflightWork());
  }

  /**
   * Return a deterministic content-based hash that identifies this node's
   * position and role in the tree topology.
   *
   * The hash is derived from the node's constructor name and its
   * human-readable `name` (composites and decorators also fold in their
   * children's hashes to form a Merkle tree). Because it is based on
   * content rather than instance identity, the same tree factory will
   * produce the same hashes across process restarts — making it safe to
   * use as a serialization key for persisting and restoring execution
   * state via {@link serialize} and {@link restore}.
   *
   * The result is computed lazily on first access and cached for the
   * lifetime of the node.
   */
  contentHash(): string {
    if (this._contentHash === null) {
      this._contentHash = this.computeHash();
    }
    return this._contentHash;
  }

  protected computeHash(): string {
    return computeContentHash(this.constructor.name, this.name);
  }

  /**
   * Return a promise that resolves when all unsettled in-flight work in
   * this node and its descendants has completed, or `null` if there is
   * no pending work.
   *
   * The returned promise never rejects — errors from in-flight work are
   * captured in `_inflightState.error` and swallowed here so that callers
   * (such as `BehaviorTree.settled()`) can safely await without handling
   * rejections.
   *
   * @returns A void promise that resolves once all pending async work has
   *   settled, or `null` if no work is in flight.
   */
  inflightPromise(): Promise<void> | null {
    const promises: Promise<void>[] = [];
    if (this._inflightState && this._inflightState.result === undefined && this._inflightState.error === undefined) {
      // Swallow rejections — errors are already captured in _inflightState.error
      // by the .then(onFulfilled, onRejected) handler attached in execute().
      // Without this, callers like settled() would get an unhandled rejection
      // when inflight work is aborted.
      promises.push(this._inflightState.promise.then(() => {}, () => {}));
    }
    for (const child of this.children) {
      const p = child.inflightPromise();
      if (p) promises.push(p);
    }
    return promises.length > 0 ? Promise.all(promises).then(() => {}) : null;
  }

  /**
   * Serialize this node's execution state into a plain object for
   * persistence.
   *
   * The base implementation returns an empty object (no state to save).
   * Subclasses that hold execution state — such as composites tracking
   * their committed child order and completed-children map, or decorators
   * tracking attempt counts — override this to include that state.
   *
   * The returned {@link NodeState} is keyed by {@link contentHash} in the
   * serialized tree snapshot, so the same factory-built tree can restore
   * its progress after a process restart.
   *
   * @returns A plain object representing this node's execution state,
   *   or an empty object if the node is stateless.
   *
   * @see {@link restore} to rehydrate from a previously serialized state.
   * @see {@link contentHash} for the key used to identify this node in
   *   the serialized snapshot.
   */
  serialize(): NodeState {
    return {};
  }

  /**
   * Restore this node's execution state from a previously serialized
   * {@link NodeState}.
   *
   * The base implementation is a no-op. Subclasses that override
   * {@link serialize} should also override this method to rehydrate
   * their internal state. Composites, for example, restore their
   * committed child order and completed-children map so that a resumed
   * tree continues from where it left off.
   *
   * @param _state - The serialized state produced by a prior
   *   {@link serialize} call.
   * @param _hashToNode - A lookup map from content hash to live node
   *   instance, built by the deserialization infrastructure. Composites
   *   use this to resolve child hashes back to node references.
   *
   * @see {@link serialize} for the corresponding serialization method.
   */
  restore(_state: NodeState, _hashToNode: Map<string, BTreeNode>): void {
    // Default: no state to restore
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
   * **Important:** If your node returns `RUNNING` to indicate async work is
   * in progress, you must route that work through {@link _inflightState}.
   * The tree runner uses `_inflightState` to detect pending work, wait for
   * it to settle, and support interrupts. Returning `RUNNING` without
   * setting `_inflightState` will cause the runner to treat the tree as
   * suspended after two ticks and stop the tick loop. See
   * {@link _inflightState} for the full pattern and {@link ActionNode} for
   * a reference implementation.
   *
   * @param context - The execution context carrying the blackboard, event
   *   emitter, and optional abort signal.
   */
  protected abstract execute(context: TreeContext): Promise<NodeStatus>;
}
