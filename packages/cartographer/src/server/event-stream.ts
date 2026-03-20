export interface StreamEntry {
  /** Opaque, monotonically increasing ID. Stringified numeric for in-process, Redis Stream ID for store-backed. */
  id: string;
  event: string;
  data: Record<string, unknown>;
  ts: string;
}

export interface EventStream {
  /** Push an event into the stream. Returns the assigned StreamEntry. */
  push(event: string, data: Record<string, unknown>): StreamEntry;

  /**
   * Get events after the given ID for replay on reconnect.
   * Returns null if the requested ID has been evicted (caller should re-snapshot).
   */
  replaySince(lastId: string): StreamEntry[] | null;

  /** The ID of the most recent event, or "0" if empty. */
  readonly latestId: string;

  /**
   * Subscribe to live events. Called for each new event pushed to the stream.
   * Returns an unsubscribe function.
   */
  subscribe(callback: (entry: StreamEntry) => void): () => void;
}

/**
 * In-process event stream backed by a ring buffer.
 * Uses stringified numeric IDs (1, 2, 3...) and synchronous dispatch.
 */
export class InProcessEventStream implements EventStream {
  private buffer: StreamEntry[] = [];
  private nextId = 1;
  private readonly listeners = new Set<(entry: StreamEntry) => void>();

  constructor(private readonly capacity = 500) {}

  get latestId(): string {
    return String(this.nextId - 1);
  }

  push(event: string, data: Record<string, unknown>): StreamEntry {
    const entry: StreamEntry = {
      id: String(this.nextId++),
      event,
      data,
      ts: new Date().toISOString(),
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
    for (const listener of this.listeners) {
      listener(entry);
    }
    return entry;
  }

  replaySince(lastId: string): StreamEntry[] | null {
    if (this.buffer.length === 0) return [];

    const numId = parseInt(lastId, 10);
    const oldestId = parseInt(this.buffer[0].id, 10);

    if (numId > 0 && numId < oldestId) {
      return null;
    }

    return this.buffer.filter((e) => parseInt(e.id, 10) > numId);
  }

  subscribe(callback: (entry: StreamEntry) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
}
