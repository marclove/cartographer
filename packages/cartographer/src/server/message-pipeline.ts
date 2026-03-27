import type { BehaviorTree } from '../core/behavior-tree.js';
import type { StateStore } from '../state/state-store.js';
import type { ActorMessage } from '../actor/types.js';
import type { ProcessResult } from '../actor/message-processor.js';
import { MessageProcessor } from '../actor/message-processor.js';
import type { EventBridge } from './event-bridge.js';

/** @internal */
function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Discriminated union returned by {@link MessagePipelineHandle.acquireOrQueue}.
 *
 * Check the `queued` field to determine which variant you have:
 *
 * - `queued: false` — the lock was acquired; proceed to
 *   {@link MessagePipelineHandle.executeMessage} with the returned `requestId`.
 * - `queued: true, queueFull: false` — the message was enqueued at `position`.
 * - `queued: true, queueFull: true` — the queue is at capacity; the message
 *   was rejected (position is `-1`).
 *
 * Every variant includes an {@link EventBridge} that has already been wired to
 * the session's event stream.
 */
export type AcquireResult =
  | { queued: false; requestId: string; bridge: EventBridge }
  | { queued: true; bridge: EventBridge; position: number; queueFull: false }
  | { queued: true; bridge: EventBridge; position: number; queueFull: true };

/**
 * Returned by {@link MessagePipelineHandle.processMessage} when a message
 * cannot be processed immediately and is placed in the queue instead.
 */
export interface QueuedResult {
  queued: true;
  /** The unique identifier assigned to this queued message. */
  messageId: string;
  /** 1-based position in the queue. */
  position: number;
}

/**
 * Public API surface returned by {@link createMessagePipeline}.
 *
 * The handle exposes the full message lifecycle: acquiring the session lock
 * (or falling back to the queue), executing a message through the behavior
 * tree, and draining queued messages after each execution completes.
 */
export interface MessagePipelineHandle {
  /**
   * Attempt to acquire the session lock. If the lock is held by another
   * request, enqueue the message instead.
   */
  acquireOrQueue(msg: ActorMessage, sessionKey: string, messageId?: string): Promise<AcquireResult>;
  /**
   * Run a message through the behavior tree while holding the session lock.
   * The lock is released in `finally`, followed by a queue drain and stream
   * eviction schedule — regardless of success or failure.
   */
  executeMessage(msg: ActorMessage, sessionKey: string, requestId: string, bridge: EventBridge): Promise<ProcessResult>;
  /**
   * High-level entry point that combines lock acquisition and execution.
   *
   * @returns A {@link ProcessResult} when the message was processed
   *   immediately, a {@link QueuedResult} when it was enqueued, or `null`
   *   when the queue is full.
   */
  processMessage(msg: ActorMessage, sessionKey: string): Promise<ProcessResult | QueuedResult | null>;
  /**
   * Process the next queued message for a session, if any. Called
   * automatically after each {@link executeMessage} completes. Can also
   * be called manually (e.g. on server restart) to resume a stalled queue.
   */
  drainQueue(sessionKey: string): Promise<void>;
  /**
   * Map of currently executing processors, keyed by session. Exposed so
   * that the HTTP layer can send interrupt signals to in-flight messages
   * (e.g. via `POST /api/messages/:id/interrupt`).
   */
  activeProcessors: Map<string, { actor: MessageProcessor; messageId: string }>;
}

/**
 * Dependencies injected into {@link createMessagePipeline}.
 *
 * The pipeline never imports session-stream or route modules directly.
 * Instead, `app.ts` (the composition root) wires cross-cutting concerns
 * via the `createBridge` and `scheduleStreamEviction` callbacks.
 */
export interface MessagePipelineOptions {
  /** Factory that produces a fresh {@link BehaviorTree} for each message. */
  createTree: () => BehaviorTree;
  /** Persistence backend for state, locks, events, and the message queue. */
  stateStore: StateStore;
  /**
   * How to handle topology mismatches when restoring serialized state.
   * See {@link AppOptions.topologyPolicy} for details.
   */
  topologyPolicy: 'fail' | 'reset';
  /**
   * Maximum queued messages per session. When the queue is full,
   * {@link MessagePipelineHandle.acquireOrQueue} returns `queueFull: true`.
   */
  maxQueueDepth: number;
  /** Key-value pairs written to the blackboard before the first tick. */
  context: Record<string, unknown>;
  /**
   * Factory that creates an {@link EventBridge} scoped to a session and
   * message. Provided by the composition root so the bridge can close over
   * the session's event stream and statistics tracker.
   */
  createBridge: (sessionKey: string, messageId?: string) => EventBridge;
  /**
   * Callback invoked after every message execution to schedule TTL-based
   * cleanup of idle session streams. See {@link SessionStreamsHandle.scheduleStreamEviction}.
   */
  scheduleStreamEviction: (sessionKey: string) => void;
}

/**
 * Create a serial message-processing pipeline for behavior tree sessions.
 *
 * The pipeline guarantees that only one message is processed per session at
 * a time. Additional messages are enqueued via the {@link StateStore} and
 * drained automatically after each execution completes. This serialization
 * prevents concurrent tree ticks from corrupting shared session state.
 *
 * ### Processing lifecycle
 *
 * ```
 * 1. acquireOrQueue  — try to grab the session lock; fall back to queue
 * 2. executeMessage  — hydrate tree, tick, persist state, emit events
 * 3. finally         — release lock → drainQueue → scheduleStreamEviction
 * ```
 *
 * The lock is held for the duration of step 2 and renewed via a 10-second
 * heartbeat interval to prevent expiry during long-running ticks.
 *
 * @example
 * ```ts
 * const pipeline = createMessagePipeline({
 *   createTree: () => new BehaviorTree(myRoot),
 *   stateStore,
 *   topologyPolicy: 'fail',
 *   maxQueueDepth: 16,
 *   context: {},
 *   createBridge: (sessionKey, messageId) =>
 *     new EventBridge(stateStore, sessionKey, messageId),
 *   scheduleStreamEviction: (sessionKey) =>
 *     streams.scheduleStreamEviction(sessionKey),
 * });
 *
 * const result = await pipeline.processMessage(
 *   { type: 'tick' },
 *   'session-abc',
 * );
 * ```
 */
export function createMessagePipeline(options: MessagePipelineOptions): MessagePipelineHandle {
  const {
    createTree,
    stateStore,
    topologyPolicy,
    maxQueueDepth,
    context,
    createBridge,
    scheduleStreamEviction,
  } = options;

  const activeProcessors = new Map<string, { actor: MessageProcessor; messageId: string }>();

  /**
   * Try to acquire the session lock. On success, return the lock's request ID
   * so the caller can proceed to {@link executeMessage}. On failure, enqueue
   * the message and emit a `message:queued` event via the bridge.
   *
   * The message's `id` field is overwritten with the bridge's canonical
   * message ID before returning, ensuring consistent identification across
   * all downstream events.
   */
  async function acquireOrQueue(
    msg: ActorMessage,
    sessionKey: string,
    messageId?: string,
  ): Promise<AcquireResult> {
    const requestId = generateRequestId();
    const acquired = await stateStore.acquireLock(sessionKey, requestId, 30000);
    const bridge = createBridge(sessionKey, messageId);
    msg.id = bridge.messageId;
    if (acquired) return { queued: false, requestId, bridge };
    try {
      const { position } = await stateStore.enqueueMessage(sessionKey, msg, maxQueueDepth);
      await bridge.emitQueued(position);
      return { queued: true, bridge, position, queueFull: false };
    } catch {
      return { queued: true, bridge, position: -1, queueFull: true };
    }
  }

  /**
   * Execute a single message while holding the session lock.
   *
   * Creates a fresh {@link MessageProcessor}, processes the message, and
   * emits the appropriate lifecycle event (`processed`, `interrupted`, or
   * `failed`). A 10-second heartbeat renews the 30-second lock TTL so that
   * long-running ticks don't lose the lock.
   *
   * The `finally` block always:
   * 1. Removes the processor from {@link activeProcessors}.
   * 2. Clears the heartbeat interval.
   * 3. Releases the session lock.
   * 4. Kicks off {@link drainQueue} for the next queued message (fire-and-forget).
   * 5. Calls `scheduleStreamEviction` to start the idle-stream TTL.
   */
  async function executeMessage(
    msg: ActorMessage,
    sessionKey: string,
    requestId: string,
    bridge: EventBridge,
  ): Promise<ProcessResult> {
    const heartbeat = setInterval(async () => {
      try { await stateStore.renewLock(sessionKey, requestId, 30000); } catch {}
    }, 10000);

    try {
      const actor = new MessageProcessor({
        createTree,
        stateStore,
        stateKey: sessionKey,
        topologyPolicy,
        eventBridge: bridge,
        context,
      });
      activeProcessors.set(sessionKey, { actor, messageId: bridge.messageId });
      const result = await actor.process(msg);
      if (result.interrupted) await bridge.emitInterrupted();
      await bridge.emitProcessed(String(result.treeStatus));
      return result;
    } catch (error) {
      await bridge.emitFailed(error instanceof Error ? error.message : String(error));
      return { treeStatus: 'error', error: error instanceof Error ? error.message : String(error) };
    } finally {
      activeProcessors.delete(sessionKey);
      clearInterval(heartbeat);
      await stateStore.releaseLock(sessionKey, requestId);
      drainQueue(sessionKey).catch(() => {});
      scheduleStreamEviction(sessionKey);
    }
  }

  /**
   * High-level entry point: acquire the lock (or queue), then execute.
   *
   * @returns The tree's {@link ProcessResult} when processed immediately,
   *   a {@link QueuedResult} when enqueued, or `null` when the queue is full.
   */
  async function processMessage(msg: ActorMessage, sessionKey: string): Promise<ProcessResult | QueuedResult | null> {
    const prep = await acquireOrQueue(msg, sessionKey, msg.id);
    if (prep.queued) return prep.queueFull ? null : { queued: true, messageId: prep.bridge.messageId, position: prep.position };
    return executeMessage(msg, sessionKey, prep.requestId, prep.bridge);
  }

  /**
   * Attempt to process the next queued message for a session.
   *
   * Acquires the session lock, dequeues the oldest message, emits a
   * `message:dequeued` event, then hands off to {@link executeMessage}
   * (fire-and-forget). If the lock cannot be acquired — meaning another
   * request is already processing — this is a no-op; the active request's
   * own `finally` block will call `drainQueue` when it finishes.
   */
  async function drainQueue(sessionKey: string): Promise<void> {
    const requestId = generateRequestId();
    const acquired = await stateStore.acquireLock(sessionKey, requestId, 30000);
    if (!acquired) return;
    const msg = await stateStore.dequeueMessage(sessionKey);
    if (!msg) {
      await stateStore.releaseLock(sessionKey, requestId);
      return;
    }
    const bridge = createBridge(sessionKey, msg.id);
    msg.id = bridge.messageId;
    await bridge.emitDequeued();
    executeMessage(msg, sessionKey, requestId, bridge).catch(() => {});
  }

  return {
    acquireOrQueue,
    executeMessage,
    processMessage,
    drainQueue,
    activeProcessors,
  };
}
