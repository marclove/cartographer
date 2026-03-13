import type { Blackboard, TreeEvents } from '../types.js';
import type { EventEmitter } from './event-emitter.js';

/**
 * A blackboard wrapper that emits `blackboard:write` events on every `set()` call.
 *
 * Wraps any {@link Blackboard} implementation and forwards all operations to it.
 * The only added behavior is emitting a `blackboard:write` event through the
 * provided {@link EventEmitter} whenever a value is written.
 *
 * `scoped()` returns another `ObservableBlackboard` wrapping the inner scoped
 * view, so writes through scoped views also emit events (with the full
 * prefixed key).
 */
export class ObservableBlackboard implements Blackboard {
  constructor(
    private readonly inner: Blackboard,
    private readonly events: EventEmitter<TreeEvents>,
    private readonly prefix: string = '',
  ) {}

  get<T>(key: string): T | undefined {
    return this.inner.get<T>(key);
  }

  set<T>(key: string, value: T): void {
    this.inner.set(key, value);
    const fullKey = this.prefix ? `${this.prefix}:${key}` : key;
    this.events.emit('blackboard:write', { key: fullKey, value, source: 'blackboard' });
  }

  has(key: string): boolean {
    return this.inner.has(key);
  }

  delete(key: string): void {
    this.inner.delete(key);
  }

  keys(): string[] {
    return this.inner.keys();
  }

  scoped(namespace: string): Blackboard {
    const innerScoped = this.inner.scoped(namespace);
    const newPrefix = this.prefix ? `${this.prefix}:${namespace}` : namespace;
    return new ObservableBlackboard(innerScoped, this.events, newPrefix);
  }
}
