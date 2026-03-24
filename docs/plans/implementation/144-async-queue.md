# Task 144: AsyncQueue Utility

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `AsyncQueue<T>`, a push/pull async iterable queue used by `ClaudeSDKAgent` to bridge `send()` calls with the SDK's `AsyncIterable<SDKUserMessage>` prompt input.

**Architecture:** A standard concurrency primitive. Producers call `push(item)` to enqueue. Consumers iterate via `async *[Symbol.asyncIterator]()`. Waiting consumers are resolved immediately when items arrive. Supports `close()` for normal completion and `close(err)` for error propagation.

**Tech Stack:** TypeScript, no external dependencies.

**Spec:** `docs/superpowers/specs/2026-03-22-extract-agent-definition-design.md` — see "AsyncQueue Utility" section.

---

### Step 1: Write failing tests

Create `packages/cartographer/src/agent/async-queue.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { AsyncQueue } from './async-queue.js';

describe('AsyncQueue', () => {
  it('yields items pushed before iteration', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();

    const items: number[] = [];
    for await (const item of q) {
      items.push(item);
    }
    expect(items).toEqual([1, 2]);
  });

  it('yields items pushed during iteration', async () => {
    const q = new AsyncQueue<number>();

    const items: number[] = [];
    const done = (async () => {
      for await (const item of q) {
        items.push(item);
      }
    })();

    q.push(1);
    q.push(2);
    // Allow microtasks to resolve
    await new Promise((r) => setTimeout(r, 10));
    q.close();
    await done;

    expect(items).toEqual([1, 2]);
  });

  it('close() completes the iterator after remaining items', async () => {
    const q = new AsyncQueue<string>();
    q.push('a');
    q.close();
    q.push('b'); // should be silently dropped

    const items: string[] = [];
    for await (const item of q) {
      items.push(item);
    }
    expect(items).toEqual(['a']);
  });

  it('close(err) throws for a waiting consumer', async () => {
    const q = new AsyncQueue<number>();
    const error = new Error('queue error');

    const iterPromise = (async () => {
      const items: number[] = [];
      for await (const item of q) {
        items.push(item);
      }
      return items;
    })();

    // Let consumer start waiting
    await new Promise((r) => setTimeout(r, 10));
    q.close(error);

    await expect(iterPromise).rejects.toThrow('queue error');
  });

  it('close(err) discards pending items', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close(new Error('closed'));

    const items: number[] = [];
    try {
      for await (const item of q) {
        items.push(item);
      }
    } catch {
      // expected
    }
    expect(items).toEqual([]);
  });

  it('push after close is silently dropped', () => {
    const q = new AsyncQueue<number>();
    q.close();
    expect(() => q.push(1)).not.toThrow();
  });

  it('supports multiple sequential iterations after close and reopen', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);

    const iter = q[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value).toBe(1);

    q.close();
    const last = await iter.next();
    expect(last.done).toBe(true);
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm --filter cartographer exec vitest run src/agent/async-queue.test.ts`
Expected: FAIL — cannot import `AsyncQueue`

### Step 3: Implement AsyncQueue

Create `packages/cartographer/src/agent/async-queue.ts`:

```typescript
/**
 * A push/pull async iterable queue.
 *
 * Producers enqueue items with `push()`. Consumers iterate via
 * `for await...of`. Items pushed while no consumer is waiting are
 * buffered. Items pushed while a consumer is waiting resolve immediately.
 *
 * Call `close()` to signal normal completion — the iterator yields any
 * remaining buffered items, then finishes. Call `close(err)` to signal
 * an error — the iterator throws for any waiting consumer and discards
 * pending items.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private resolve: ((value: IteratorResult<T>) => void) | null = null;
  private reject: ((err: Error) => void) | null = null;
  private closed = false;
  private error: Error | null = null;

  /** Enqueue an item. Silently dropped if the queue is closed. */
  push(item: T): void {
    if (this.closed) return;
    if (this.resolve) {
      const resolve = this.resolve;
      this.resolve = null;
      this.reject = null;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  /**
   * Signal completion or error.
   *
   * Without an argument, the iterator yields remaining buffered items
   * then completes. With an error, any waiting consumer receives the
   * error and pending items are discarded.
   */
  close(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (err) {
      this.error = err;
      this.buffer.length = 0;
      if (this.reject) {
        const reject = this.reject;
        this.resolve = null;
        this.reject = null;
        reject(err);
      }
    } else if (this.resolve && this.buffer.length === 0) {
      const resolve = this.resolve;
      this.resolve = null;
      this.reject = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<T> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.closed) {
        if (this.error) throw this.error;
        return;
      }
      // Wait for next push or close
      const result = await new Promise<IteratorResult<T>>((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
      });
      if (result.done) return;
      yield result.value;
    }
  }
}
```

### Step 4: Run test to verify it passes

Run: `pnpm --filter cartographer exec vitest run src/agent/async-queue.test.ts`
Expected: PASS (all 7 tests)

### Step 5: Commit

```bash
git add packages/cartographer/src/agent/async-queue.ts packages/cartographer/src/agent/async-queue.test.ts
git commit -m "feat(agent): add AsyncQueue push/pull async iterable utility"
```
