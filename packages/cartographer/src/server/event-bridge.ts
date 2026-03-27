import type { BehaviorTree } from '../core/behavior-tree.js';
import type { TreeEvents } from '../types.js';
import type { StateStore, TreeEvent } from '../state/state-store.js';
import { serializeEvent } from './serializers.js';

/** @internal */
function generateEventId(): string {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** @internal */
function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A serialized event waiting in the internal buffer before being persisted. */
interface BufferedEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Bridges behavior tree events to a {@link StateStore} for persistence and
 * optional real-time forwarding (e.g. SSE streaming to connected clients).
 *
 * EventBridge serves two purposes:
 *
 * 1. **Buffering** — Tree events emitted during a tick are collected in an
 *    internal buffer. When message processing completes (or fails), the buffer
 *    is flushed to the state store in a single batch, keeping write operations
 *    efficient.
 *
 * 2. **Real-time forwarding** — An optional `onEvent` callback receives every
 *    event as it occurs, before it is persisted. {@link ActorServer} uses this
 *    to push events over SSE to connected clients with minimal latency.
 *
 * Each EventBridge instance is scoped to a single message. The {@link messageId}
 * property identifies that message across all events it produces.
 *
 * ### Lifecycle
 *
 * ```
 * 1. Construct an EventBridge (auto-generates or accepts a messageId)
 * 2. Call bridgeTree(tree) to subscribe to tree events
 * 3. Tick the tree — events buffer internally, onEvent fires immediately
 * 4. Call a terminal emitter (emitProcessed / emitInterrupted / emitFailed)
 *    which flushes the buffer then appends the lifecycle event
 * ```
 *
 * For queued messages that haven't started processing yet, use
 * {@link emitQueued} and {@link emitDequeued} — these skip the flush step
 * because no tree events exist at that point.
 *
 * @example
 * ```ts
 * const bridge = new EventBridge(stateStore, sessionKey, msg.id, (event) => {
 *   sseStream.push(event); // forward to client in real time
 * });
 *
 * bridge.bridgeTree(tree);
 * await tree.tick();
 * await bridge.emitProcessed(tree.status);
 * ```
 */
export class EventBridge {
  /** The unique identifier for the message this bridge is tracking. */
  readonly messageId: string;
  private buffer: BufferedEvent[] = [];

  /**
   * @param stateStore - Persistence backend where events are appended.
   * @param stateKey - The state store key that identifies the session
   *   (the session key from `AppOptions.sessionId`).
   * @param messageId - Optional client-supplied message ID. When omitted, a
   *   unique ID is generated automatically.
   * @param onEvent - Optional callback invoked synchronously for every event
   *   (both buffered tree events and lifecycle events) as soon as it occurs.
   *   Useful for real-time streaming (e.g. SSE).
   */
  constructor(
    private stateStore: StateStore,
    private stateKey: string,
    messageId?: string,
    private onEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ) {
    this.messageId = messageId ?? generateMessageId();
  }

  /**
   * Subscribe to all events emitted by the given tree. Must be called before
   * ticking the tree so that no events are missed.
   *
   * Events are serialized via {@link serializeEvent} and pushed to the
   * internal buffer. If an `onEvent` callback was provided at construction,
   * it fires immediately for each event — before the buffer is flushed.
   *
   * @param tree - The behavior tree whose events should be captured.
   */
  bridgeTree(tree: BehaviorTree): void {
    tree.events.onAny((type, data) => {
      const serialized = { type, data: serializeEvent(type as keyof TreeEvents, data as any) };
      this.buffer.push(serialized);
      this.onEvent?.(serialized);
    });
  }

  /**
   * Flush all buffered tree events to the state store, then append a
   * `message:processed` lifecycle event indicating the message completed
   * successfully.
   *
   * @param treeStatus - The final status of the tree after processing
   *   (e.g. `'success'`, `'failure'`, `'running'`).
   */
  async emitProcessed(treeStatus: string): Promise<void> {
    await this.flush();
    const event = { type: 'message:processed', data: { messageId: this.messageId, treeStatus } };
    this.onEvent?.(event);
    await this.stateStore.appendEvents(this.stateKey, [{
      id: generateEventId(),
      ...event,
      timestamp: Date.now(),
    }]);
  }

  /**
   * Flush all buffered tree events to the state store, then append a
   * `message:interrupted` lifecycle event indicating processing was
   * cancelled before completion (e.g. by an abort signal or a newer message
   * preempting this one).
   */
  async emitInterrupted(): Promise<void> {
    await this.flush();
    const event = { type: 'message:interrupted', data: { messageId: this.messageId } };
    this.onEvent?.(event);
    await this.stateStore.appendEvents(this.stateKey, [{
      id: generateEventId(),
      ...event,
      timestamp: Date.now(),
    }]);
  }

  /**
   * Flush all buffered tree events to the state store, then append a
   * `message:failed` lifecycle event indicating an unrecoverable error
   * occurred during processing.
   *
   * @param error - A human-readable description of what went wrong.
   */
  async emitFailed(error: string): Promise<void> {
    await this.flush();
    const event = { type: 'message:failed', data: { messageId: this.messageId, error } };
    this.onEvent?.(event);
    await this.stateStore.appendEvents(this.stateKey, [{
      id: generateEventId(),
      ...event,
      timestamp: Date.now(),
    }]);
  }

  /**
   * Append a `message:queued` lifecycle event indicating the message could
   * not be processed immediately and has been placed in the queue.
   *
   * Unlike the terminal emitters, this does **not** flush the tree event
   * buffer — no tree has been ticked yet at this point.
   *
   * @param position - The 1-based position of the message in the queue.
   */
  async emitQueued(position: number): Promise<void> {
    const event = { type: 'message:queued', data: { messageId: this.messageId, position } };
    this.onEvent?.(event);
    await this.stateStore.appendEvents(this.stateKey, [{
      id: generateEventId(),
      ...event,
      timestamp: Date.now(),
    }]);
  }

  /**
   * Append a `message:dequeued` lifecycle event indicating the message has
   * been pulled from the queue and is about to start processing.
   *
   * Like {@link emitQueued}, this does **not** flush the tree event buffer.
   */
  async emitDequeued(): Promise<void> {
    const event = { type: 'message:dequeued', data: { messageId: this.messageId } };
    this.onEvent?.(event);
    await this.stateStore.appendEvents(this.stateKey, [{
      id: generateEventId(),
      ...event,
      timestamp: Date.now(),
    }]);
  }

  /**
   * Persist all buffered tree events to the state store and clear the buffer.
   *
   * Each buffered event is stamped with a unique ID and the current timestamp
   * before being written. If the buffer is empty, this is a no-op.
   */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const events: TreeEvent[] = this.buffer.map((e) => ({
      id: generateEventId(),
      type: e.type,
      data: e.data,
      timestamp: Date.now(),
    }));
    this.buffer = [];
    await this.stateStore.appendEvents(this.stateKey, events);
  }
}
