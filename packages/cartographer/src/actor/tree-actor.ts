import { BehaviorTree } from '../core/behavior-tree.js';
import { NodeStatus } from '../types.js';
import { serializeTree, restoreTree } from '../core/serialization.js';
import type { StateStore } from '../state/state-store.js';
import type { ActorMessage } from './types.js';
import type { EventBridge } from '../server/event-bridge.js';
import { blackboardToRecord } from '../server/sse-handler.js';

/**
 * Configuration for creating a {@link TreeActor}.
 */
export interface TreeActorOptions {
  /** Factory function that creates a fresh {@link BehaviorTree} instance for each message. */
  createTree: () => BehaviorTree;
  /** Persistent store used to load and save tree session state between messages. */
  stateStore: StateStore;
  /** Unique key identifying this tree's session within the {@link StateStore}. */
  stateKey: string;
  /**
   * How to handle topology mismatches when restoring serialized state onto a
   * tree whose structure has changed since the state was saved.
   *
   * - `'fail'` (default) — throw an error if the saved state doesn't match the current tree shape.
   * - `'reset'` — silently discard mismatched node state and continue with a fresh subtree.
   */
  topologyPolicy?: 'fail' | 'reset';
  /** Optional event bridge for streaming tree events to connected clients. */
  eventBridge?: EventBridge;
}

/**
 * The outcome of processing a single {@link ActorMessage} through a {@link TreeActor}.
 */
export interface ProcessResult {
  /**
   * The terminal status of the tree after processing. One of:
   * - {@link NodeStatus.SUCCESS} — the tree completed successfully.
   * - {@link NodeStatus.FAILURE} — the tree completed with failure.
   * - {@link NodeStatus.RUNNING} — the tree is still running (suspended or held).
   * - `'error'` — the message was a signal that was handled without ticking.
   */
  treeStatus: NodeStatus | 'error';
  /** Human-readable error or signal description when `treeStatus` is `'error'`. */
  error?: string;
  /** `true` when processing was cut short by a call to {@link TreeActor.requestInterrupt}. */
  interrupted?: boolean;
  /** `true` when the tree is held (paused after interrupt) and a tick message was skipped. */
  held?: boolean;
}

/**
 * Transient per-message processor for a behavior tree session.
 *
 * A `TreeActor` is created for each incoming request and handles exactly one
 * {@link ActorMessage}. It encapsulates the full processing pipeline:
 *
 * 1. **Load** — retrieve persisted session state from the {@link StateStore}.
 * 2. **Hydrate** — create a fresh tree via the factory and restore blackboard + node state.
 * 3. **Apply** — write the incoming message (command, write, signal, or tick) onto the tree.
 * 4. **Run** — tick the tree in a loop until it reaches a terminal status or is interrupted.
 * 5. **Serialize** — snapshot the blackboard and node state.
 * 6. **Save** — persist the snapshot back to the store.
 *
 * After processing, the actor is discarded. This design ensures each message
 * is processed in isolation with no shared mutable state between requests.
 *
 * @example
 * ```ts
 * const actor = new TreeActor({
 *   createTree: () => buildMyTree(),
 *   stateStore: myRedisStore,
 *   stateKey: 'session:abc123',
 * });
 *
 * const result = await actor.process({ type: 'tick' });
 * console.log(result.treeStatus); // 'SUCCESS', 'FAILURE', or 'RUNNING'
 * ```
 */
export class TreeActor {
  private createTree: () => BehaviorTree;
  private stateStore: StateStore;
  private stateKey: string;
  private topologyPolicy: 'fail' | 'reset';
  private eventBridge?: EventBridge;
  private interruptController: AbortController | null = null;

  /**
   * Create a new `TreeActor`.
   *
   * @param options - Configuration for this actor. See {@link TreeActorOptions}.
   */
  constructor(options: TreeActorOptions) {
    this.createTree = options.createTree;
    this.stateStore = options.stateStore;
    this.stateKey = options.stateKey;
    this.topologyPolicy = options.topologyPolicy ?? 'fail';
    this.eventBridge = options.eventBridge;
  }

  /**
   * Signal the in-progress processing loop to stop early.
   *
   * This is the entry point for the interrupt flow. Calling this method
   * aborts the internal `interruptController` (an `AbortController`), which
   * triggers the following cascade:
   *
   * 1. {@link raceSettledOrInterrupt} resolves to `true` (interrupt wins the race).
   * 2. {@link runToCompletion} throws `Error('interrupted')` to unwind the tick loop.
   * 3. {@link process} catches the error, calls `tree.interrupt()` to cancel
   *    unsettled async work while preserving composite cycle state, then saves
   *    the session with `held: true`.
   *
   * Once held, subsequent `tick` messages are no-ops (returning `{ held: true }`)
   * until the held state is cleared by a `command`, `write`, or `resume` signal.
   *
   * Safe to call at any time — if no processing is in progress, the
   * `AbortController` is `null` and the call is a no-op.
   */
  requestInterrupt(): void {
    this.interruptController?.abort();
  }

  /**
   * Process a single message through the behavior tree.
   *
   * This is the main entry point for the actor. It executes the full pipeline
   * (load, hydrate, apply, run, serialize, save) and returns a {@link ProcessResult}
   * describing the outcome.
   *
   * **Message types and their effects:**
   *
   * - `tick` — triggers the tree's run-to-completion loop. If the tree is held,
   *   the tick is skipped and `{ held: true }` is returned.
   * - `command` — writes `msg.payload` to the blackboard under `commands:<name>`,
   *   then ticks the tree.
   * - `write` — sets an arbitrary blackboard key, then ticks the tree.
   * - `signal` — applies a control signal (`reset`, `abort`, `resume`) without
   *   running the tick loop. The resulting `treeStatus` is `'error'` with a
   *   descriptive message.
   *
   * @param msg - The message to process. See {@link ActorMessage}.
   * @returns The processing outcome including the tree's final status.
   * @throws Re-throws any error from the tree tick loop that is not an interrupt.
   */
  async process(msg: ActorMessage): Promise<ProcessResult> {
    const tree = this.createTree();
    this.eventBridge?.bridgeTree(tree);

    // Load and restore state
    const stored = await this.stateStore.getState(this.stateKey);
    if (stored) {
      for (const [key, value] of Object.entries(stored.blackboard)) {
        tree.blackboard.set(key, value);
      }
      restoreTree(tree.root, tree.rootHash, stored.treeState, this.topologyPolicy);
      tree.restoreSessionRegistry(stored.sessions ?? {});
    }

    // Handle held state: tick messages are no-ops, command/write clear held,
    // signal:resume clears held without ticking
    if (stored?.held) {
      if (msg.type === 'tick') {
        return { treeStatus: NodeStatus.RUNNING, held: true };
      }
      if (msg.type === 'signal' && msg.signal === 'resume') {
        await this.stateStore.saveState(this.stateKey, { ...stored, held: false });
        return { treeStatus: 'error', error: 'Signal handled: resume' };
      }
      // command/write: clear held flag, then fall through to normal processing
      await this.stateStore.saveState(this.stateKey, { ...stored, held: false });
    }

    // Apply message
    if (msg.type === 'command') {
      tree.blackboard.set(`commands:${msg.name}`, msg.payload ?? {});
    } else if (msg.type === 'write') {
      tree.blackboard.set(msg.key, msg.value);
    } else if (msg.type === 'signal') {
      return this.handleSignal(tree, stored, msg.signal);
    }

    // Run the tick loop. runToCompletion() uses throw/catch as a control flow
    // mechanism for interrupts: it throws Error('interrupted') to guarantee
    // immediate exit from the nested while(true)/await loop regardless of
    // which branch is currently executing. A boolean flag would require
    // checking after every await point, which is more error-prone.
    this.interruptController = new AbortController();
    let interrupted = false;
    let treeStatus: NodeStatus;
    try {
      treeStatus = await this.runToCompletion(tree);
    } catch (e) {
      if ((e as Error).message === 'interrupted') {
        // Interrupt caught — cancel unsettled async work (e.g., pending
        // AgentNode responses) but preserve composite cycle state so that
        // already-completed children are not re-executed on the next tick.
        tree.interrupt();
        treeStatus = NodeStatus.RUNNING;
        interrupted = true;
      } else {
        // Not an interrupt — this is a genuine error, re-throw it.
        throw e;
      }
    } finally {
      this.interruptController = null;
    }

    // Serialize and save. When interrupted, set held: true so that
    // subsequent tick messages are no-ops until the hold is cleared.
    const blackboardSnapshot = blackboardToRecord(tree.blackboard);
    const treeState = serializeTree(tree.root, tree.rootHash);
    await this.stateStore.saveState(this.stateKey, {
      blackboard: blackboardSnapshot,
      treeState,
      sessions: tree.sessionRegistry.toRecord(),
      createdAt: stored?.createdAt ?? Date.now(),
      lastMessageAt: Date.now(),
      ...(interrupted && { held: true }),
    });

    return { treeStatus, ...(interrupted && { interrupted: true }) };
  }

  /**
   * Tick the tree in a loop until it reaches a terminal status (`SUCCESS` or
   * `FAILURE`) or is interrupted.
   *
   * When the tree returns `RUNNING` with inflight async work (e.g., an
   * `AgentNode` awaiting a Claude response), this method races the tree's
   * `settled()` promise against the interrupt signal via
   * {@link raceSettledOrInterrupt}.
   *
   * **Suspension detection:** If the tree returns `RUNNING` with no inflight
   * work, it could mean a fast action completed during the tick and its result
   * is pending collection, or the tree is genuinely suspended (waiting for an
   * external event). The method ticks once more to distinguish — if still
   * `RUNNING` with no inflight work on the second consecutive tick, the tree
   * is considered suspended and the method returns `RUNNING`.
   *
   * This heuristic depends on nodes routing their async work through
   * `BaseNode._inflightState`. If a custom node returns `RUNNING` without
   * setting `_inflightState`, `hasInflightWork()` returns `false` and the
   * runner will treat the tree as suspended after two ticks — even if real
   * work is happening externally. See `BaseNode._inflightState` for the
   * contract that nodes must follow.
   *
   * **Interrupt as throw:** This method uses `throw new Error('interrupted')`
   * as a structured control flow mechanism to exit the `while (true)` loop.
   * The loop contains multiple `await` points and branching paths (`continue`,
   * `return`). Throwing guarantees immediate unwinding regardless of which
   * branch is active, without requiring a flag check after every `await`.
   * The caller ({@link process}) catches this specific error and handles it
   * gracefully — it is not a failure condition.
   *
   * @param tree - The hydrated behavior tree to run.
   * @returns The tree's terminal status (`SUCCESS` or `FAILURE`), or `RUNNING`
   *   if the tree is suspended with no inflight work.
   * @throws `Error('interrupted')` when {@link requestInterrupt} is called
   *   during execution. This is caught by {@link process} — not a true error.
   */
  private async runToCompletion(tree: BehaviorTree): Promise<NodeStatus> {
    let consecutiveNoInflight = 0;
    while (true) {
      const status = await tree.tick();
      if (status !== NodeStatus.RUNNING) return status;

      if (tree.hasInflightWork()) {
        // Race the tree's pending async work against the interrupt signal.
        // If the interrupt wins, throw to unwind the loop immediately.
        const interrupted = await this.raceSettledOrInterrupt(tree);
        if (interrupted) {
          throw new Error('interrupted');
        }
        consecutiveNoInflight = 0;
        continue;
      }

      // RUNNING with no inflight work: either a fast action completed during
      // the tick (result pending collection) or the tree is truly suspended.
      // Tick once more to distinguish — if still RUNNING with no inflight
      // on the second pass, the tree is suspended and we return.
      consecutiveNoInflight++;
      if (consecutiveNoInflight >= 2) return status;
    }
  }

  /**
   * Race the tree's `settled()` promise against the interrupt signal.
   *
   * This is the mechanism that makes the tick loop interruptible. While
   * {@link runToCompletion} waits for async node work to finish (e.g., an
   * `AgentNode` calling the Claude API), an external caller can invoke
   * {@link requestInterrupt} at any time. This method turns that into a
   * race: whichever resolves first — the tree's work or the abort signal
   * — determines the return value.
   *
   * The race is implemented manually (rather than `Promise.race`) to ensure
   * proper cleanup of the `abort` event listener when the tree settles first,
   * avoiding listener leaks on the `AbortSignal`.
   *
   * **Short-circuit behavior:**
   * - If no `AbortController` exists (should not happen in practice), falls
   *   back to waiting for `settled()` and returns `false`.
   * - If the signal is already aborted (interrupt arrived before this call),
   *   returns `true` immediately without waiting.
   *
   * @param tree - The tree whose inflight work to wait on.
   * @returns `true` if the interrupt signal fired first, `false` if the
   *   tree's async work settled normally.
   */
  private raceSettledOrInterrupt(tree: BehaviorTree): Promise<boolean> {
    const signal = this.interruptController?.signal;
    if (!signal) return tree.settled().then(() => false);
    if (signal.aborted) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      let resolved = false;

      const onInterrupt = () => {
        if (!resolved) { resolved = true; resolve(true); }
      };

      // Listen for the abort signal (interrupt wins the race)
      signal.addEventListener('abort', onInterrupt, { once: true });

      // Listen for the tree's work to settle (normal completion wins the race)
      tree.settled().then(() => {
        if (!resolved) {
          resolved = true;
          signal.removeEventListener('abort', onInterrupt);
          resolve(false);
        }
      });
    });
  }

  /**
   * Handle a control signal (`reset`, `abort`, or other) without running the
   * tick loop.
   *
   * Applies the signal to the tree (e.g., calling `tree.reset()` or
   * `tree.abort()`), then persists the resulting state so the effect is
   * durable across subsequent messages.
   *
   * @param tree - The hydrated behavior tree.
   * @param stored - Previously persisted session state, if any.
   * @param signal - The signal name to handle.
   * @returns A {@link ProcessResult} with `treeStatus: 'error'` and a descriptive message.
   */
  private async handleSignal(tree: BehaviorTree, stored: { createdAt?: number } | null, signal: string): Promise<ProcessResult> {
    if (signal === 'reset') tree.reset();
    if (signal === 'abort') tree.abort();

    // Save state so the reset/abort is persisted for the next tick
    const blackboard = blackboardToRecord(tree.blackboard);
    const treeState = serializeTree(tree.root, tree.rootHash);
    await this.stateStore.saveState(this.stateKey, {
      blackboard,
      treeState,
      sessions: tree.sessionRegistry.toRecord(),
      createdAt: stored?.createdAt ?? Date.now(),
      lastMessageAt: Date.now(),
    });

    return { treeStatus: 'error', error: `Signal handled: ${signal}` };
  }

}
