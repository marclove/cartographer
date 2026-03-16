import type { StateStore, TreeSessionState, TreeEvent } from './state-store.js';

export class InMemoryStateStore implements StateStore {
  private store = new Map<string, TreeSessionState>();
  private locks = new Map<string, string>();
  private eventBuffers = new Map<string, TreeEvent[]>();
  private eventWaiters = new Map<string, Array<() => void>>();
  private maxEvents: number;

  constructor(options?: { maxEvents?: number }) {
    this.maxEvents = options?.maxEvents ?? 1000;
  }

  // --- State ---

  async getState(key: string): Promise<TreeSessionState | null> {
    return this.store.get(key) ?? null;
  }

  async saveState(key: string, state: TreeSessionState): Promise<void> {
    this.store.set(key, structuredClone(state));
  }

  async deleteState(key: string): Promise<void> {
    this.store.delete(key);
    this.eventBuffers.delete(key);
  }

  async listKeys(): Promise<string[]> {
    return [...this.store.keys()];
  }

  // --- Locking ---

  async acquireLock(key: string, requestId: string, _ttlMs: number): Promise<boolean> {
    if (this.locks.has(key)) return false;
    this.locks.set(key, requestId);
    return true;
  }

  async releaseLock(key: string, requestId: string): Promise<void> {
    if (this.locks.get(key) === requestId) {
      this.locks.delete(key);
    }
  }

  // --- Events ---

  async appendEvents(key: string, newEvents: TreeEvent[]): Promise<void> {
    let buffer = this.eventBuffers.get(key);
    if (!buffer) {
      buffer = [];
      this.eventBuffers.set(key, buffer);
    }
    buffer.push(...newEvents);
    if (buffer.length > this.maxEvents) {
      buffer.splice(0, buffer.length - this.maxEvents);
    }
    const waiters = this.eventWaiters.get(key);
    if (waiters) {
      for (const resolve of waiters) resolve();
      this.eventWaiters.delete(key);
    }
  }

  async *readEvents(key: string, lastEventId?: string): AsyncIterable<TreeEvent> {
    const buffer = this.eventBuffers.get(key) ?? [];

    let startIndex = 0;
    if (lastEventId) {
      const idx = buffer.findIndex(e => e.id === lastEventId);
      if (idx !== -1) startIndex = idx + 1;
    }
    for (let i = startIndex; i < buffer.length; i++) {
      yield buffer[i];
    }

    while (true) {
      const currentLen = (this.eventBuffers.get(key) ?? []).length;
      await new Promise<void>(resolve => {
        let waiters = this.eventWaiters.get(key);
        if (!waiters) {
          waiters = [];
          this.eventWaiters.set(key, waiters);
        }
        waiters.push(resolve);
      });

      const allEvents = this.eventBuffers.get(key) ?? [];
      for (let i = currentLen; i < allEvents.length; i++) {
        yield allEvents[i];
      }
    }
  }
}
