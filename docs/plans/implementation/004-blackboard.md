# Task 4: Blackboard Implementation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the Blackboard key-value store with namespace scoping support.

**Architecture:** A `MapBlackboard` backed by a `Map<string, unknown>`. Scoped blackboards prefix all keys with `namespace:` and delegate to the parent map.

**Tech Stack:** TypeScript

---

### Step 1: Write failing tests

Create `src/core/blackboard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { MapBlackboard } from './blackboard.js';

describe('MapBlackboard', () => {
  it('stores and retrieves values', () => {
    const bb = new MapBlackboard();
    bb.set('key', 42);
    expect(bb.get<number>('key')).toBe(42);
  });

  it('returns undefined for missing keys', () => {
    const bb = new MapBlackboard();
    expect(bb.get('missing')).toBeUndefined();
  });

  it('checks key existence with has()', () => {
    const bb = new MapBlackboard();
    bb.set('key', 'value');
    expect(bb.has('key')).toBe(true);
    expect(bb.has('missing')).toBe(false);
  });

  it('deletes keys', () => {
    const bb = new MapBlackboard();
    bb.set('key', 'value');
    bb.delete('key');
    expect(bb.has('key')).toBe(false);
    expect(bb.get('key')).toBeUndefined();
  });

  it('lists all keys', () => {
    const bb = new MapBlackboard();
    bb.set('a', 1);
    bb.set('b', 2);
    expect(bb.keys().sort()).toEqual(['a', 'b']);
  });

  it('accepts initial data', () => {
    const bb = new MapBlackboard({ x: 10, y: 20 });
    expect(bb.get<number>('x')).toBe(10);
    expect(bb.get<number>('y')).toBe(20);
  });

  it('returns a snapshot via toRecord()', () => {
    const bb = new MapBlackboard();
    bb.set('a', 1);
    bb.set('b', 'hello');
    expect(bb.toRecord()).toEqual({ a: 1, b: 'hello' });
  });
});

describe('Scoped Blackboard', () => {
  it('prefixes keys with namespace', () => {
    const bb = new MapBlackboard();
    const scoped = bb.scoped('agent1');

    scoped.set('result', 'done');
    expect(bb.get('agent1:result')).toBe('done');
    expect(scoped.get<string>('result')).toBe('done');
  });

  it('only lists keys within its namespace', () => {
    const bb = new MapBlackboard();
    bb.set('global', 1);
    bb.set('ns:local', 2);

    const scoped = bb.scoped('ns');
    expect(scoped.keys()).toEqual(['local']);
  });

  it('has() only checks within namespace', () => {
    const bb = new MapBlackboard();
    bb.set('global', 1);
    bb.set('ns:local', 2);

    const scoped = bb.scoped('ns');
    expect(scoped.has('local')).toBe(true);
    expect(scoped.has('global')).toBe(false);
  });

  it('delete() only affects namespaced keys', () => {
    const bb = new MapBlackboard();
    bb.set('ns:key', 'value');
    bb.set('other', 'safe');

    const scoped = bb.scoped('ns');
    scoped.delete('key');

    expect(bb.has('ns:key')).toBe(false);
    expect(bb.has('other')).toBe(true);
  });

  it('supports nested scoping', () => {
    const bb = new MapBlackboard();
    const scoped = bb.scoped('a').scoped('b');

    scoped.set('key', 'nested');
    expect(bb.get('a:b:key')).toBe('nested');
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/core/blackboard.test.ts`
Expected: FAIL — cannot import `MapBlackboard`

### Step 3: Implement MapBlackboard

Create `src/core/blackboard.ts`:

```typescript
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
```

### Step 4: Run test to verify it passes

Run: `npx vitest run src/core/blackboard.test.ts`
Expected: PASS (all 10 tests)

### Step 5: Commit

```bash
git add src/core/blackboard.ts src/core/blackboard.test.ts
git commit -m "feat: implement blackboard with namespace scoping"
```
