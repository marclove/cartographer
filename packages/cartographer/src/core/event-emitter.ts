import type { TypedEventEmitter } from '../types.js';

/**
 * A type-safe, in-memory event emitter.
 *
 * `EventEmitter` is the concrete implementation of the {@link TypedEventEmitter}
 * interface. The `TEvents` type parameter constrains which event names can be
 * used with `on`, `off`, and `emit`, and infers the correct payload type for
 * each event automatically.
 *
 * Throughout the framework, `EventEmitter<TreeEvents>` carries node lifecycle
 * events, agent activity, and strategy decisions across a tree tick. The same
 * class is reusable for any typed event map.
 *
 * **Implementation details:**
 * - Listeners are stored in a `Map<eventName, Set<listener>>`. Because a `Set`
 *   is used, registering the same listener function reference more than once
 *   for the same event has no effect — it will only be called once per `emit`.
 * - Events are emitted synchronously. All listeners for an event are called
 *   in the order they were registered before `emit` returns.
 * - `off` and `emit` are silent no-ops for events with no listeners.
 *
 * @example
 * ```ts
 * interface MyEvents {
 *   'data': { value: number };
 *   'done': { success: boolean };
 * }
 *
 * const emitter = new EventEmitter<MyEvents>();
 *
 * emitter.on('data', ({ value }) => console.log('Got:', value));
 * emitter.emit('data', { value: 42 }); // logs: Got: 42
 *
 * // Unsubscribe:
 * const handler = ({ value }: { value: number }) => console.log(value);
 * emitter.on('data', handler);
 * emitter.off('data', handler);
 *
 * // Remove all listeners for all events:
 * emitter.removeAllListeners();
 * ```
 *
 * @typeParam TEvents - A record mapping event name strings to their payload types.
 */
export class EventEmitter<TEvents extends { [K in keyof TEvents]: unknown }>
  implements TypedEventEmitter<TEvents>
{
  private listeners = new Map<string, Set<(data: unknown) => void>>();
  private anyListeners = new Set<(event: string, data: unknown) => void>();

  /**
   * Subscribe to an event.
   *
   * The listener is called each time the event is emitted, receiving the
   * typed payload as its argument. Adding the same listener reference for
   * the same event more than once has no effect — duplicates are ignored.
   */
  on<K extends keyof TEvents & string>(event: K, listener: (data: TEvents[K]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as (data: unknown) => void);
  }

  /**
   * Unsubscribe a previously registered listener.
   *
   * If the listener was not registered, or if no listeners exist for the
   * event, this is a silent no-op.
   */
  off<K extends keyof TEvents & string>(event: K, listener: (data: TEvents[K]) => void): void {
    this.listeners.get(event)?.delete(listener as (data: unknown) => void);
  }

  /**
   * Emit an event, calling all registered listeners synchronously.
   *
   * Listeners are invoked in the order they were registered. If no
   * listeners are registered for the event, this is a silent no-op.
   */
  emit<K extends keyof TEvents & string>(event: K, data: TEvents[K]): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        listener(data);
      }
    }
    for (const listener of this.anyListeners) {
      listener(event, data);
    }
  }

  /**
   * Subscribe to all events.
   *
   * The listener is called for every emitted event, receiving the event name
   * and payload. Wildcard listeners are invoked after per-event listeners.
   * Adding the same listener reference more than once has no effect.
   */
  onAny(listener: (event: string, data: unknown) => void): void {
    this.anyListeners.add(listener);
  }

  /**
   * Unsubscribe a previously registered wildcard listener.
   *
   * If the listener was not registered, this is a silent no-op.
   */
  offAny(listener: (event: string, data: unknown) => void): void {
    this.anyListeners.delete(listener);
  }

  /**
   * Remove all listeners for all events.
   *
   * After this call, no events will be dispatched until new listeners are
   * registered with `on`.
   */
  removeAllListeners(): void {
    this.listeners.clear();
    this.anyListeners.clear();
  }
}
