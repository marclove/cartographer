import type { Blackboard } from '../types.js';

export class MapBlackboard implements Blackboard {
  private data: Map<string, unknown>;

  constructor(initial?: Record<string, unknown>) {
    this.data = new Map(initial ? Object.entries(initial) : []);
  }

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.data.set(key, value);
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  delete(key: string): void {
    this.data.delete(key);
  }

  keys(): string[] {
    return Array.from(this.data.keys());
  }

  scoped(namespace: string): Blackboard {
    return new ScopedBlackboard(this.data, namespace);
  }

  toRecord(): Record<string, unknown> {
    return Object.fromEntries(this.data);
  }
}

class ScopedBlackboard implements Blackboard {
  constructor(
    private data: Map<string, unknown>,
    private prefix: string,
  ) {}

  private prefixed(key: string): string {
    return `${this.prefix}:${key}`;
  }

  get<T>(key: string): T | undefined {
    return this.data.get(this.prefixed(key)) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.data.set(this.prefixed(key), value);
  }

  has(key: string): boolean {
    return this.data.has(this.prefixed(key));
  }

  delete(key: string): void {
    this.data.delete(this.prefixed(key));
  }

  keys(): string[] {
    const prefixWithColon = `${this.prefix}:`;
    return Array.from(this.data.keys())
      .filter((k) => k.startsWith(prefixWithColon))
      .map((k) => k.slice(prefixWithColon.length));
  }

  scoped(namespace: string): Blackboard {
    return new ScopedBlackboard(this.data, `${this.prefix}:${namespace}`);
  }
}
