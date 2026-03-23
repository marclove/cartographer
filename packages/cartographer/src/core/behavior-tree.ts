import { NodeStatus } from '../types.js';
import type { BehaviorTreeConfig, BTreeNode, Blackboard, TickLoopHandle, TreeContext, TreeEvents } from '../types.js';
import { EventEmitter } from './event-emitter.js';
import { InMemoryBlackboard } from './blackboard.js';
import { ObservableBlackboard } from './observable-blackboard.js';
import { BaseNode } from '../nodes/base.js';
import { TreeScheduler } from '../scheduler/tree-scheduler.js';
import { SessionRegistry } from './session-registry.js';

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
   * If no blackboard was supplied in the config, a `InMemoryBlackboard` is
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

  readonly root: BTreeNode;

  /** Named session registry for agent conversation sharing. */
  readonly sessionRegistry: SessionRegistry;

  /** Content hash of the root node — fingerprint of the entire tree topology. */
  get rootHash(): string {
    return this.root.contentHash();
  }
  private abortController: AbortController;
  private _scheduler: TreeScheduler | null = null;

  constructor(config: BehaviorTreeConfig) {
    this.name = config.name;
    this.root = config.root;
    this.blackboard = config.blackboard ?? new InMemoryBlackboard();
    this.events = new EventEmitter<TreeEvents>();
    this.abortController = new AbortController();
    this.sessionRegistry = config.sessionRegistry ?? new SessionRegistry();
    BehaviorTree.validateUniqueIds(this.root);
    if (config.onElicitation && this.root instanceof BaseNode) {
      this.root.mergeContextOverrides({ onElicitation: config.onElicitation });
    }
    this.events.emit('tree:init', { tree: this.name, root: this.root.name });
  }

  /**
   * Walk the tree and verify that every node has a unique ID.
   *
   * Uses the `children` accessor on `BTreeNode` to traverse the tree
   * iteratively. Throws on the first duplicate ID found.
   */
  private static validateUniqueIds(root: BTreeNode): void {
    const seen = new Set<string>();
    const stack: BTreeNode[] = [root];

    while (stack.length > 0) {
      const node = stack.pop()!;
      if (seen.has(node.id)) {
        throw new Error(
          `Duplicate node ID "${node.id}" found in tree. ` +
          `Node IDs must be unique. The duplicate was found on node "${node.name}".`
        );
      }
      seen.add(node.id);
      for (const child of node.children) {
        stack.push(child);
      }
    }
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
      blackboard: new ObservableBlackboard(this.blackboard, this.events),
      events: this.events,
      signal: this.abortController.signal,
      sessions: this.sessionRegistry,
    };

    const start = performance.now();
    const status = await this.root.tick(context);
    const durationMs = performance.now() - start;
    this.events.emit('tree:tick', { tree: this.name, status, durationMs });
    if (status !== NodeStatus.RUNNING) {
      this.sessionRegistry.reset();
    }
    return status;
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
   * `InMemoryBlackboard`). Otherwise `blackboard` will be an empty object.
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
    this.events.emit('tree:reset', { tree: this.name });
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
    this.events.emit('tree:abort', { tree: this.name });
  }

  /**
   * Cancel in-flight work without destroying tree state.
   *
   * Unlike {@link abort}, interrupt preserves composite cycle state
   * (completedMap, committedOrder) so that previously completed children
   * are not re-executed. The tree remains tickable immediately — no
   * {@link reset} call needed.
   *
   * Does NOT trigger the tree's AbortController (that would permanently
   * prevent further ticks).
   */
  interrupt(): void {
    this.root.interrupt();
    this.events.emit('tree:interrupt', { tree: this.name });
  }

  /** Returns true if any node in the tree has unsettled in-flight work. */
  hasInflightWork(): boolean {
    return this.root.hasInflightWork();
  }

  /**
   * Returns a promise that resolves when all in-flight work across the tree has settled.
   * Uses Promise.all (not allSettled) — nodes handle their own errors internally.
   */
  async settled(): Promise<void> {
    const promise = this.root.inflightPromise();
    if (promise) await promise;
  }

  /**
   * Start a reactive tick loop that ticks the tree on a fixed interval.
   *
   * Creates a `TreeScheduler` with reactive-friendly defaults:
   * - `skipOnOverlap: true` — skips a tick if the previous one is still running
   * - `abortOnStop: true` — aborts in-flight work when the loop stops
   *
   * Returns a {@link TickLoopHandle} whose `stop()` method stops the loop
   * and waits for any in-flight tick to complete.
   *
   * Throws if a tick loop is already running. Call `stop()` on the existing
   * handle before starting a new loop.
   *
   * @param options.intervalMs - Milliseconds between ticks.
   * @param options.signal - Optional `AbortSignal` that stops the loop when aborted.
   *
   * @example
   * ```ts
   * const handle = tree.start({ intervalMs: 100 });
   * // ... later
   * await handle.stop();
   * ```
   */
  start(options: { intervalMs: number; signal?: AbortSignal }): TickLoopHandle {
    if (this._scheduler?.isRunning) {
      throw new Error('Tick loop is already running. Call stop() first.');
    }

    const scheduler = new TreeScheduler({
      tree: this,
      schedule: { type: 'interval', delayMs: options.intervalMs },
      skipOnOverlap: true,
      abortOnStop: true,
    });

    this._scheduler = scheduler;
    scheduler.start(); // fire-and-forget, resolves when stopped

    const abortHandler = () => { scheduler.stop(); };
    if (options.signal) {
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    return {
      stop: async () => {
        options.signal?.removeEventListener('abort', abortHandler);
        await scheduler.stop();
        this._scheduler = null;
      },
    };
  }
}
