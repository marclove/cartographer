import type { StateStore, TreeSessionState, TreeEvent } from './state-store.js';
import type { ActorMessage } from '../actor/types.js';

export class InMemoryStateStore implements StateStore {
  private store = new Map<string, TreeSessionState>();
  private locks = new Map<string, string>();
  private eventBuffers = new Map<string, TreeEvent[]>();
  private eventWaiters = new Map<string, Array<() => void>>();
  private queues = new Map<string, ActorMessage[]>();
  private maxEvents: number;

  constructor(options?: { maxEvents?: number }) {
    this.maxEvents = options?.maxEvents ?? 10000;
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
    this.queues.delete(key);
  }

  async listKeys(): Promise<string[]> {
    return [...this.store.keys()];
  }

  async clearHeld(key: string): Promise<boolean> {
    const state = this.store.get(key);
    if (!state?.held) return false;
    state.held = false;
    return true;
  }

  // --- Locking ---

  async acquireLock(key: string, requestId: string, _ttlMs: number): Promise<boolean> {
    if (this.locks.has(key)) return false;
    this.locks.set(key, requestId);
    return true;
  }

  async renewLock(key: string, requestId: string, _ttlMs: number): Promise<boolean> {
    return this.locks.get(key) === requestId;
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

  async *readEvents(key: string, lastEventId?: string, options?: { signal?: AbortSignal }): AsyncIterable<TreeEvent> {
    const signal = options?.signal;
    const buffer = this.eventBuffers.get(key) ?? [];

    let startIndex = 0;
    if (lastEventId) {
      const idx = buffer.findIndex(e => e.id === lastEventId);
      if (idx !== -1) startIndex = idx + 1;
    }
    for (let i = startIndex; i < buffer.length; i++) {
      if (signal?.aborted) return;
      yield buffer[i];
    }

    while (!signal?.aborted) {
      const currentLen = (this.eventBuffers.get(key) ?? []).length;
      await new Promise<void>(resolve => {
        let waiters = this.eventWaiters.get(key);
        if (!waiters) {
          waiters = [];
          this.eventWaiters.set(key, waiters);
        }
        waiters.push(resolve);
        // If already aborted, resolve immediately to unblock
        if (signal?.aborted) resolve();
      });

      if (signal?.aborted) return;

      const allEvents = this.eventBuffers.get(key) ?? [];
      for (let i = currentLen; i < allEvents.length; i++) {
        if (signal?.aborted) return;
        yield allEvents[i];
      }
    }
  }

  // --- Queue ---

  async enqueueMessage(stateKey: string, message: ActorMessage, maxQueueDepth: number): Promise<{ position: number; queueSize: number }> {
    let queue = this.queues.get(stateKey);
    if (!queue) {
      queue = [];
      this.queues.set(stateKey, queue);
    }
    if (queue.length >= maxQueueDepth) {
      throw new Error('Queue full');
    }
    queue.push(message);
    return { position: queue.length, queueSize: queue.length };
  }

  async dequeueMessage(stateKey: string): Promise<ActorMessage | null> {
    const queue = this.queues.get(stateKey);
    if (!queue || queue.length === 0) return null;
    return queue.shift()!;
  }

  async getQueueSize(stateKey: string): Promise<number> {
    return this.queues.get(stateKey)?.length ?? 0;
  }

  async getQueuedMessages(stateKey: string): Promise<ActorMessage[]> {
    return [...(this.queues.get(stateKey) ?? [])];
  }

  async listQueuedKeys(): Promise<string[]> {
    return [...this.queues.entries()]
      .filter(([, q]) => q.length > 0)
      .map(([k]) => k);
  }
}
