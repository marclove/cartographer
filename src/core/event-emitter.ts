import type { TypedEventEmitter } from '../types.js';

export class EventEmitter<TEvents extends { [K in keyof TEvents]: unknown }>
  implements TypedEventEmitter<TEvents>
{
  private listeners = new Map<string, Set<(data: unknown) => void>>();

  on<K extends keyof TEvents & string>(event: K, listener: (data: TEvents[K]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as (data: unknown) => void);
  }

  off<K extends keyof TEvents & string>(event: K, listener: (data: TEvents[K]) => void): void {
    this.listeners.get(event)?.delete(listener as (data: unknown) => void);
  }

  emit<K extends keyof TEvents & string>(event: K, data: TEvents[K]): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        listener(data);
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
