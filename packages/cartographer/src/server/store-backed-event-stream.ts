import type { EventStream, StreamEntry } from './event-stream.js';
import type { StateStore } from '../state/state-store.js';

/**
 * EventStream backed by a StateStore's readEvents() async iterable.
 *
 * Designed for distributed/multi-server deployments where events originate
 * from a shared store (e.g. Redis Streams) rather than local push() calls.
 * Events are consumed via a background subscription and buffered locally
 * for replay support.
 */
export class StoreBackedEventStream implements EventStream {
  private buffer: StreamEntry[] = [];
  private readonly listeners = new Set<(entry: StreamEntry) => void>();
  private abortController: AbortController | null = null;

  constructor(
    private readonly stateStore: StateStore,
    private readonly stateKey: string,
    private readonly capacity: number = 500,
  ) {}

  get latestId(): string {
    if (this.buffer.length === 0) return '0';
    return this.buffer[this.buffer.length - 1].id;
  }

  /**
   * No-op for store-backed streams. Events arrive via the subscription,
   * not from local pushes.
   */
  push(_event: string, _data: Record<string, unknown>): StreamEntry {
    return { id: '0', event: _event, data: _data, ts: new Date().toISOString() };
  }

  replaySince(lastId: string): StreamEntry[] | null {
    if (this.buffer.length === 0) return [];

    if (lastId === '0') {
      return [...this.buffer];
    }

    const idx = this.buffer.findIndex((e) => e.id === lastId);
    if (idx === -1) {
      return null;
    }

    return this.buffer.slice(idx + 1);
  }

  subscribe(callback: (entry: StreamEntry) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Start consuming events from the state store in the background.
   * Each TreeEvent is converted to a StreamEntry, buffered, and dispatched
   * to all subscribers.
   */
  startSubscription(fromId?: string): void {
    // Stop any existing subscription to prevent duplicate dispatches
    this.stop();

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const run = async () => {
      try {
        const iterable = this.stateStore.readEvents(this.stateKey, fromId, { signal });
        for await (const event of iterable) {
          if (signal.aborted) break;

          const entry: StreamEntry = {
            id: event.id,
            event: event.type,
            data: event.data as Record<string, unknown>,
            ts: new Date(event.timestamp).toISOString(),
          };

          this.buffer.push(entry);
          if (this.buffer.length > this.capacity) {
            this.buffer.shift();
          }

          for (const listener of this.listeners) {
            listener(entry);
          }
        }
      } catch {
        // Subscription ended (abort or error) — silently exit.
      }
    };

    // Fire and forget — the loop runs until stop() or the iterable ends.
    run();
  }

  /** Abort the background subscription. */
  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
