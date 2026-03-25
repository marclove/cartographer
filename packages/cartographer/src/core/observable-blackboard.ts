import type { Blackboard, TreeEvents } from '../types.js';
import type { EventEmitter } from './event-emitter.js';

/**
 * A blackboard wrapper that emits read, write, and delete events for both
 * single and bulk operations.
 *
 * Wraps any {@link Blackboard} implementation and forwards all operations to it.
 * In addition to delegating, it emits typed events through the provided
 * {@link EventEmitter}:
 * - `blackboard:read` on `get()` and per key on `getMany()`
 * - `blackboard:write` on `set()` and per entry on `setMany()`
 * - `blackboard:delete` on `delete()` and per key on `deleteMany()`
 * - `blackboard:keys` on `keys()`
 *
 * `scoped()` returns another `ObservableBlackboard` wrapping the inner scoped
 * view, so all operations through scoped views also emit events with the full
 * prefixed key.
 */
export class ObservableBlackboard implements Blackboard {
  constructor(
    private readonly inner: Blackboard,
    private readonly events: EventEmitter<TreeEvents>,
    private readonly prefix: string = '',
  ) {}

  get<T>(key: string): T | undefined {
    const value = this.inner.get<T>(key);
    const fullKey = this.prefix ? `${this.prefix}:${key}` : key;
    this.events.emit('blackboard:read', { key: fullKey, value, hit: value !== undefined, source: 'blackboard' });
    return value;
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
    const fullKey = this.prefix ? `${this.prefix}:${key}` : key;
    this.events.emit('blackboard:delete', { key: fullKey, source: 'blackboard' });
  }

  keys(): string[] {
    const keys = this.inner.keys();
    this.events.emit('blackboard:keys', { keys, source: 'blackboard' });
    return keys;
  }

  getMany(keys: string[]): Record<string, unknown> {
    const result = this.inner.getMany(keys);
    for (const key of keys) {
      const fullKey = this.prefix ? `${this.prefix}:${key}` : key;
      const value = result[key];
      this.events.emit('blackboard:read', { key: fullKey, value, hit: value !== undefined, source: 'blackboard' });
    }
    return result;
  }

  setMany(entries: Record<string, unknown>): void {
    this.inner.setMany(entries);
    for (const [key, value] of Object.entries(entries)) {
      const fullKey = this.prefix ? `${this.prefix}:${key}` : key;
      this.events.emit('blackboard:write', { key: fullKey, value, source: 'blackboard' });
    }
  }

  deleteMany(keys: string[]): void {
    this.inner.deleteMany(keys);
    for (const key of keys) {
      const fullKey = this.prefix ? `${this.prefix}:${key}` : key;
      this.events.emit('blackboard:delete', { key: fullKey, source: 'blackboard' });
    }
  }

  scoped(namespace: string): Blackboard {
    const innerScoped = this.inner.scoped(namespace);
    const newPrefix = this.prefix ? `${this.prefix}:${namespace}` : namespace;
    return new ObservableBlackboard(innerScoped, this.events, newPrefix);
  }
}
