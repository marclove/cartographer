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
