import { NodeStatus } from '../types.js';
import type { BehaviorTreeConfig, BTreeNode, Blackboard, TreeContext, TreeEvents } from '../types.js';
import { EventEmitter } from './event-emitter.js';
import { MapBlackboard } from './blackboard.js';

/**
 * The top-level runner for a behavior tree.
 *
 * `BehaviorTree` owns the root node, the shared blackboard, the event
 * emitter, and an abort controller. Each call to {@link tick} constructs a
 * {@link TreeContext} and passes it to the root node, which propagates it
 * through the entire tree.
 *
 * **Basic usage:**
 * ```ts
 * const tree = new BehaviorTree({
 *   name: 'my-tree',
 *   root: myRootNode,
 * });
 *
 * const status = await tree.tick();
 * // status is NodeStatus.SUCCESS, FAILURE, or RUNNING
 * ```
 *
 * **Listening to events:**
 * ```ts
 * tree.events.on('node:exit', ({ node, status, durationMs }) => {
 *   console.log(`${node.name}: ${status} in ${durationMs}ms`);
 * });
 * ```
 *
 * **Running to completion and inspecting state:**
 * ```ts
 * const { status, blackboard } = await tree.run();
 * console.log(status, blackboard['result']);
 * ```
 */
export class BehaviorTree {
  /** Human-readable name provided at construction. */
  readonly name: string;

  /**
   * The shared key-value store accessible to every node during a tick.
   *
   * If no blackboard was supplied in the config, a `MapBlackboard` is
   * created automatically. The optional `toRecord()` method is used by
   * {@link run} to produce a plain-object snapshot of all stored values.
   */
  readonly blackboard: Blackboard & { toRecord?(): Record<string, unknown> };

  /**
   * The event emitter for this tree.
   *
   * Subscribe here to observe node lifecycle events (`node:enter`,
   * `node:exit`, `node:error`), agent activity (`agent:prompt`,
   * `agent:response`, `agent:tool_use`), blackboard writes, and
   * strategy decisions. See {@link TreeEvents} for the full list.
   */
  readonly events: EventEmitter<TreeEvents>;

  private root: BTreeNode;
  private abortController: AbortController;

  constructor(config: BehaviorTreeConfig) {
    this.name = config.name;
    this.root = config.root;
    this.blackboard = config.blackboard ?? new MapBlackboard();
    this.events = new EventEmitter<TreeEvents>();
    this.abortController = new AbortController();
  }

  /**
   * Execute one tick of the behavior tree.
   *
   * Creates a {@link TreeContext} — carrying the blackboard, event emitter,
   * and current abort signal — and passes it to the root node. The root
   * propagates the context to its descendants.
   *
   * Returns the status reported by the root node:
   * - `SUCCESS` — The tree completed successfully.
   * - `FAILURE` — The tree failed.
   * - `RUNNING` — The tree is mid-execution; call `tick()` again to continue.
   *
   * When the tree returns `RUNNING`, composites remember which child was
   * running and resume from it on the next tick. Call {@link reset} first
   * if you want to restart from the beginning instead.
   *
   * @example
   * ```ts
   * let status = await tree.tick();
   * while (status === NodeStatus.RUNNING) {
   *   status = await tree.tick(); // resume
   * }
   * ```
   */
  async tick(): Promise<NodeStatus> {
    const context: TreeContext = {
      blackboard: this.blackboard,
      events: this.events,
      signal: this.abortController.signal,
    };

    return this.root.tick(context);
  }

  /**
   * Tick the tree once and return the final status together with a
   * snapshot of the blackboard.
   *
   * This is a convenience wrapper around {@link tick} for situations
   * where you want to inspect the blackboard state after a single
   * end-to-end execution. If the tree returns `RUNNING`, the snapshot
   * reflects the blackboard as it stood when execution paused.
   *
   * The blackboard snapshot is only populated when the underlying
   * blackboard implementation exposes a `toRecord()` method (e.g.
   * `MapBlackboard`). Otherwise `blackboard` will be an empty object.
   *
   * @returns An object containing the tick's `status` and a plain-object
   *   `blackboard` snapshot of all stored key-value pairs.
   *
   * @example
   * ```ts
   * const { status, blackboard } = await tree.run();
   * if (status === NodeStatus.SUCCESS) {
   *   console.log('Result:', blackboard['result']);
   * }
   * ```
   */
  async run(): Promise<{ status: NodeStatus; blackboard: Record<string, unknown> }> {
    const status = await this.tick();
    const snapshot =
      'toRecord' in this.blackboard && typeof this.blackboard.toRecord === 'function'
        ? this.blackboard.toRecord()
        : {};
    return { status, blackboard: snapshot };
  }

  /**
   * Reset the tree to its initial state.
   *
   * Calls `reset()` on the root node, which cascades through every
   * composite and decorator in the tree. This clears:
   * - Composite child-resumption indices (RUNNING state)
   * - Retry and repeat attempt counters
   * - Agent node cached results
   *
   * Also replaces the internal `AbortController` so that a previously
   * aborted tree can be ticked again.
   *
   * @example
   * ```ts
   * await tree.tick(); // may return RUNNING or reach a terminal state
   * tree.reset();      // clear all node state
   * await tree.tick(); // start fresh from the root
   * ```
   */
  reset(): void {
    this.root.reset();
    this.abortController = new AbortController();
  }

  /**
   * Abort any in-progress execution and signal all nodes to stop.
   *
   * Calls `abort()` on the root node (propagating to all descendants)
   * and triggers the `AbortController`, setting `context.signal.aborted`
   * to `true` for any nodes that check it.
   *
   * After calling `abort()`, call {@link reset} before ticking again to
   * obtain a fresh abort signal.
   *
   * @example
   * ```ts
   * const tickPromise = tree.tick();
   * // Cancel if it takes too long
   * setTimeout(() => tree.abort(), 5000);
   * const status = await tickPromise;
   * tree.reset(); // required before next tick
   * ```
   */
  abort(): void {
    this.root.abort();
    this.abortController.abort();
  }
}
