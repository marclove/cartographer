# Task 3: Typed Event Emitter

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a typed event emitter that enforces event name and payload types at compile time.

**Architecture:** Simple listener map with typed `on`, `off`, `emit`, and `removeAllListeners`. No external dependencies.

**Tech Stack:** TypeScript

---

### Step 1: Write failing tests

Create `src/core/event-emitter.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from './event-emitter.js';

interface TestEvents {
  'test:foo': { value: number };
  'test:bar': { message: string };
}

describe('EventEmitter', () => {
  it('calls listener when event is emitted', () => {
    const emitter = new EventEmitter<TestEvents>();
    const listener = vi.fn();

    emitter.on('test:foo', listener);
    emitter.emit('test:foo', { value: 42 });

    expect(listener).toHaveBeenCalledWith({ value: 42 });
  });

  it('supports multiple listeners for the same event', () => {
    const emitter = new EventEmitter<TestEvents>();
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    emitter.on('test:foo', listener1);
    emitter.on('test:foo', listener2);
    emitter.emit('test:foo', { value: 1 });

    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();
  });

  it('does not call listeners for other events', () => {
    const emitter = new EventEmitter<TestEvents>();
    const fooListener = vi.fn();
    const barListener = vi.fn();

    emitter.on('test:foo', fooListener);
    emitter.on('test:bar', barListener);
    emitter.emit('test:foo', { value: 1 });

    expect(fooListener).toHaveBeenCalledOnce();
    expect(barListener).not.toHaveBeenCalled();
  });

  it('removes a specific listener with off()', () => {
    const emitter = new EventEmitter<TestEvents>();
    const listener = vi.fn();

    emitter.on('test:foo', listener);
    emitter.off('test:foo', listener);
    emitter.emit('test:foo', { value: 1 });

    expect(listener).not.toHaveBeenCalled();
  });

  it('removes all listeners with removeAllListeners()', () => {
    const emitter = new EventEmitter<TestEvents>();
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    emitter.on('test:foo', listener1);
    emitter.on('test:bar', listener2);
    emitter.removeAllListeners();
    emitter.emit('test:foo', { value: 1 });
    emitter.emit('test:bar', { message: 'hello' });

    expect(listener1).not.toHaveBeenCalled();
    expect(listener2).not.toHaveBeenCalled();
  });

  it('does not throw when emitting with no listeners', () => {
    const emitter = new EventEmitter<TestEvents>();
    expect(() => emitter.emit('test:foo', { value: 1 })).not.toThrow();
  });

  it('does not throw when removing a listener that was never added', () => {
    const emitter = new EventEmitter<TestEvents>();
    const listener = vi.fn();
    expect(() => emitter.off('test:foo', listener)).not.toThrow();
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/core/event-emitter.test.ts`
Expected: FAIL — cannot import `EventEmitter`

### Step 3: Implement EventEmitter

Create `src/core/event-emitter.ts`:

```typescript
import type { TypedEventEmitter } from '../types.js';

export class EventEmitter<TEvents extends Record<string, unknown>>
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
```

### Step 4: Run test to verify it passes

Run: `npx vitest run src/core/event-emitter.test.ts`
Expected: PASS (all 7 tests)

### Step 5: Commit

```bash
git add src/core/event-emitter.ts src/core/event-emitter.test.ts
git commit -m "feat: implement typed event emitter"
```
