export interface BufferedEvent {
  id: number;
  event: string;
  data: Record<string, unknown>;
  ts: string;
}

export class EventBuffer {
  private buffer: BufferedEvent[] = [];
  private nextId = 1;

  constructor(private readonly capacity: number) {}

  get latestId(): number {
    return this.nextId - 1;
  }

  push(event: string, data: Record<string, unknown>): BufferedEvent {
    const entry: BufferedEvent = {
      id: this.nextId++,
      event,
      data,
      ts: new Date().toISOString(),
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
    return entry;
  }

  getEventsSince(lastId: number): BufferedEvent[] | null {
    if (this.buffer.length === 0) return [];

    const oldestId = this.buffer[0].id;
    // If the client's last-seen ID predates our oldest buffered event,
    // signal that a full snapshot is needed.
    if (lastId > 0 && lastId < oldestId) {
      return null;
    }

    return this.buffer.filter((e) => e.id > lastId);
  }
}
