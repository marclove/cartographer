# Task 75: EventEmitter onAny/offAny

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `onAny`/`offAny` methods to the `EventEmitter` class and `TypedEventEmitter` interface, enabling wildcard listeners that receive all emitted events.

**Depends on:** None

---

### Step 1: Write failing tests

Add to `src/core/event-emitter.test.ts`:

```ts
describe('onAny / offAny', () => {
  it('onAny listener receives all emitted events', () => {
    interface Events { a: { x: number }; b: { y: string } }
    const emitter = new EventEmitter<Events>();
    const calls: Array<{ event: string; data: unknown }> = [];
    emitter.onAny((event, data) => calls.push({ event, data }));

    emitter.emit('a', { x: 1 });
    emitter.emit('b', { y: 'hello' });

    expect(calls).toEqual([
      { event: 'a', data: { x: 1 } },
      { event: 'b', data: { y: 'hello' } },
    ]);
  });

  it('onAny listener is called after per-event listeners', () => {
    interface Events { a: { x: number } }
    const emitter = new EventEmitter<Events>();
    const order: string[] = [];
    emitter.on('a', () => order.push('per-event'));
    emitter.onAny(() => order.push('any'));

    emitter.emit('a', { x: 1 });
    expect(order).toEqual(['per-event', 'any']);
  });

  it('offAny removes the listener', () => {
    interface Events { a: { x: number } }
    const emitter = new EventEmitter<Events>();
    const calls: string[] = [];
    const listener = (event: string) => calls.push(event);

    emitter.onAny(listener);
    emitter.emit('a', { x: 1 });
    emitter.offAny(listener);
    emitter.emit('a', { x: 2 });

    expect(calls).toEqual(['a']);
  });

  it('duplicate onAny registrations are ignored', () => {
    interface Events { a: { x: number } }
    const emitter = new EventEmitter<Events>();
    const calls: string[] = [];
    const listener = (event: string) => calls.push(event);

    emitter.onAny(listener);
    emitter.onAny(listener);
    emitter.emit('a', { x: 1 });

    expect(calls).toEqual(['a']);
  });

  it('removeAllListeners also clears onAny listeners', () => {
    interface Events { a: { x: number } }
    const emitter = new EventEmitter<Events>();
    const calls: string[] = [];
    emitter.onAny((event) => calls.push(event));

    emitter.emit('a', { x: 1 });
    emitter.removeAllListeners();
    emitter.emit('a', { x: 2 });

    expect(calls).toEqual(['a']);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/core/event-emitter.test.ts`
Expected: FAIL — `onAny` is not a function.

### Step 3: Add onAny/offAny to TypedEventEmitter interface

Edit `src/types.ts` — add two methods to the `TypedEventEmitter` interface, before `removeAllListeners`:

```ts
  /** Subscribe to all events. The listener is called for every emitted event. */
  onAny(listener: (event: string, data: unknown) => void): void;

  /** Unsubscribe a previously registered wildcard listener. */
  offAny(listener: (event: string, data: unknown) => void): void;
```

### Step 4: Implement onAny/offAny on EventEmitter

Edit `src/core/event-emitter.ts`:

Add a private field alongside `listeners`:

```ts
  private anyListeners = new Set<(event: string, data: unknown) => void>();
```

Add the `onAny` method:

```ts
  onAny(listener: (event: string, data: unknown) => void): void {
    this.anyListeners.add(listener);
  }
```

Add the `offAny` method:

```ts
  offAny(listener: (event: string, data: unknown) => void): void {
    this.anyListeners.delete(listener);
  }
```

Update `emit` to call any-listeners after per-event listeners:

```ts
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
```

Update `removeAllListeners` to also clear any-listeners:

```ts
  removeAllListeners(): void {
    this.listeners.clear();
    this.anyListeners.clear();
  }
```

### Step 5: Run tests to verify they pass

Run: `npx vitest run src/core/event-emitter.test.ts`
Expected: All pass.

### Step 6: Typecheck

Run: `npm run typecheck`
Expected: All pass.

### Step 7: Run full unit test suite

Run: `npm run test`
Expected: All pass — no existing behavior changes.

### Step 8: Commit

```bash
git add src/types.ts src/core/event-emitter.ts src/core/event-emitter.test.ts
git commit -m "feat(core): add onAny/offAny to EventEmitter for wildcard event subscription"
```
