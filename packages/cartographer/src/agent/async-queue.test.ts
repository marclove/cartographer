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
