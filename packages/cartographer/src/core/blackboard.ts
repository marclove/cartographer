import type { Blackboard } from '../types.js';

/**
 * The default in-memory implementation of {@link Blackboard}.
 *
 * `InMemoryBlackboard` stores all values in a single `Map<string, unknown>`.
 * It is created automatically by `BehaviorTree` when no blackboard is
 * supplied in the config, but you can also construct one directly when
 * you need to pre-populate data or share a blackboard across multiple trees.
 *
 * **Basic usage:**
 * ```ts
 * const bb = new InMemoryBlackboard();
 * bb.set('userId', 42);
 * bb.get<number>('userId'); // 42
 * bb.has('userId');         // true
 * bb.delete('userId');
 * bb.has('userId');         // false
 * ```
 *
 * **Pre-populating with initial values:**
 * ```ts
 * const bb = new InMemoryBlackboard({ userId: 42, mode: 'production' });
 * bb.get<number>('userId'); // 42
 * ```
 *
 * **Namespace isolation with scoped views:**
 * ```ts
 * const bb = new InMemoryBlackboard();
 * const agentBb = bb.scoped('agent1');
 *
 * agentBb.set('result', 'done');
 * agentBb.get<string>('result'); // 'done'
 * agentBb.keys();                // ['result']
 *
 * // The root blackboard stores the key with its full prefix
 * bb.get<string>('agent1:result'); // 'done'
 * bb.keys();                        // ['agent1:result']
 * ```
 *
 * **Snapshotting all stored values:**
 * ```ts
 * bb.set('a', 1);
 * bb.set('b', 2);
 * bb.toRecord(); // { a: 1, b: 2 }
 * ```
 */
export class InMemoryBlackboard implements Blackboard {
  private data: Map<string, unknown>;

  /**
   * Create a new blackboard, optionally pre-populated with key-value pairs.
   *
   * @param initial - A plain object whose entries are loaded into the
   *   blackboard at construction time. Subsequent mutations to the original
   *   object do not affect the blackboard.
   */
  constructor(initial?: Record<string, unknown>) {
    this.data = new Map(initial ? Object.entries(initial) : []);
  }

  /** Retrieve a value by key, or `undefined` if the key does not exist. */
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  /** Store a value under the given key, overwriting any previous value. */
  set<T>(key: string, value: T): void {
    this.data.set(key, value);
  }

  /** Return `true` if the key exists, `false` otherwise. */
  has(key: string): boolean {
    return this.data.has(key);
  }

  /** Remove the key and its value from the blackboard. */
  delete(key: string): void {
    this.data.delete(key);
  }

  /** Return all keys currently stored in this blackboard. */
  keys(): string[] {
    return Array.from(this.data.keys());
  }

  /** Retrieve values for multiple keys in a single call. Missing keys map to `undefined`. */
  getMany(keys: string[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = this.data.get(key);
    }
    return result;
  }

  /** Write multiple key-value pairs in a single call, overwriting existing values. */
  setMany(entries: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(entries)) {
      this.data.set(key, value);
    }
  }

  /** Remove multiple keys in a single call. Missing keys are silently ignored. */
  deleteMany(keys: string[]): void {
    for (const key of keys) {
      this.data.delete(key);
    }
  }

  /**
   * Create a namespace-isolated view of this blackboard.
   *
   * All operations on the returned blackboard automatically prefix keys
   * with `namespace:`, so writes from different scopes cannot collide.
   * The underlying storage is shared — changes made through the scoped
   * view are visible on the root blackboard (with the full prefixed key).
   *
   * Scoping can be nested: `bb.scoped('a').scoped('b')` produces keys
   * like `a:b:myKey` in the underlying map.
   *
   * @param namespace - The prefix to apply to all keys in this view.
   */
  scoped(namespace: string): Blackboard {
    return new ScopedBlackboard(this.data, namespace);
  }

  /**
   * Return all stored key-value pairs as a plain object.
   *
   * This includes entries written through scoped views (with their full
   * prefixed keys). Used by `BehaviorTree.run()` to produce a blackboard
   * snapshot alongside the final tick status.
   *
   * @example
   * ```ts
   * const bb = new InMemoryBlackboard({ x: 1 });
   * bb.scoped('agent').set('result', 'ok');
   * bb.toRecord(); // { x: 1, 'agent:result': 'ok' }
   * ```
   */
  toRecord(): Record<string, unknown> {
    return Object.fromEntries(this.data);
  }
}

/**
 * A namespace-isolated view over a shared `Map`.
 *
 * `ScopedBlackboard` is created by {@link InMemoryBlackboard.scoped} and is not
 * exported directly. Every method transparently prefixes the caller's key
 * with `prefix:` before reading from or writing to the underlying map.
 *
 * This means two scoped views with different prefixes can use the same
 * key names without any risk of collision, and values written through one
 * view are immediately visible through the root blackboard (using the full
 * prefixed key) or through another scoped view with the same prefix.
 *
 * Nested scoping is supported — calling `scoped()` on a `ScopedBlackboard`
 * creates a new `ScopedBlackboard` whose prefix is the concatenation of
 * the parent prefix and the new namespace: `parent:child`.
 */
class ScopedBlackboard implements Blackboard {
  constructor(
    private data: Map<string, unknown>,
    private prefix: string,
  ) {}

  /** Prepend the namespace prefix to produce the actual storage key. */
  private prefixed(key: string): string {
    return `${this.prefix}:${key}`;
  }

  /** Retrieve a value by its unprefixed key within this namespace. */
  get<T>(key: string): T | undefined {
    return this.data.get(this.prefixed(key)) as T | undefined;
  }

  /** Store a value under the unprefixed key within this namespace. */
  set<T>(key: string, value: T): void {
    this.data.set(this.prefixed(key), value);
  }

  /** Return `true` if the unprefixed key exists within this namespace. */
  has(key: string): boolean {
    return this.data.has(this.prefixed(key));
  }

  /** Remove the unprefixed key and its value from this namespace. */
  delete(key: string): void {
    this.data.delete(this.prefixed(key));
  }

  /** Retrieve values for multiple unprefixed keys within this namespace. Missing keys map to `undefined`. */
  getMany(keys: string[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = this.data.get(this.prefixed(key));
    }
    return result;
  }

  /** Write multiple key-value pairs within this namespace in a single call. */
  setMany(entries: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(entries)) {
      this.data.set(this.prefixed(key), value);
    }
  }

  /** Remove multiple unprefixed keys within this namespace. Missing keys are silently ignored. */
  deleteMany(keys: string[]): void {
    for (const key of keys) {
      this.data.delete(this.prefixed(key));
    }
  }

  /**
   * Return all keys that belong to this namespace, with the prefix stripped.
   *
   * Only entries whose storage key starts with `prefix:` are included.
   * The returned strings are the unprefixed keys as seen through this view.
   */
  keys(): string[] {
    const prefixWithColon = `${this.prefix}:`;
    return Array.from(this.data.keys())
      .filter((k) => k.startsWith(prefixWithColon))
      .map((k) => k.slice(prefixWithColon.length));
  }

  /**
   * Create a further-nested namespace view under this one.
   *
   * The resulting blackboard uses `{currentPrefix}:{namespace}` as its
   * prefix, so keys are stored as `{currentPrefix}:{namespace}:key`.
   *
   * @param namespace - The additional namespace segment to append.
   */
  scoped(namespace: string): Blackboard {
    return new ScopedBlackboard(this.data, `${this.prefix}:${namespace}`);
  }
}
