import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StoreBackedEventStream } from './store-backed-event-stream.js';
import type { StateStore, TreeEvent, TreeSessionState } from '../state/state-store.js';
import type { StreamEntry } from './event-stream.js';

/**
 * Creates a mock StateStore whose readEvents() is driven by a push-based
 * async generator. Call `pushEvent()` to yield events into the stream,
 * and `end()` to terminate it.
 */
function createMockStore() {
  let resolveNext: ((value: IteratorResult<TreeEvent>) => void) | null = null;
  let done = false;

  const events: TreeEvent[] = [];

  function pushEvent(event: TreeEvent) {
    events.push(event);
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve({ value: event, done: false });
    }
  }

  function end() {
    done = true;
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve({ value: undefined as unknown as TreeEvent, done: true });
    }
  }

  let readEventsCallCount = 0;
  let lastFromId: string | undefined;

  const store: StateStore = {
    getState: async () => null,
    saveState: async () => {},
    deleteState: async () => {},
    listKeys: async () => [],
    acquireLock: async () => true,
    releaseLock: async () => {},
    appendEvents: async () => {},
    readEvents(_key: string, fromId?: string): AsyncIterable<TreeEvent> {
      readEventsCallCount++;
      lastFromId = fromId;

      // Track pending event index so multiple events pushed before consumption
      // are delivered in order.
      let cursor = events.length;

      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<TreeEvent>> {
              // Deliver any already-buffered events first.
              if (cursor < events.length) {
                return { value: events[cursor++], done: false };
              }
              if (done) return { value: undefined as unknown as TreeEvent, done: true };
              return new Promise<IteratorResult<TreeEvent>>((resolve) => {
                resolveNext = (result) => {
                  if (!result.done) cursor++;
                  resolve(result);
                };
              });
            },
          };
        },
      };
    },
  };

  return { store, pushEvent, end, getReadEventsCallCount: () => readEventsCallCount, getLastFromId: () => lastFromId };
}

function makeEvent(id: string, type: string, data: Record<string, unknown> = {}): TreeEvent {
  return { id, type, data, timestamp: Date.now() };
}

describe('StoreBackedEventStream', () => {
  let mock: ReturnType<typeof createMockStore>;
  let stream: StoreBackedEventStream;

  beforeEach(() => {
    mock = createMockStore();
  });

  afterEach(() => {
    stream?.stop();
    mock.end();
  });

  it('delivers events from readEvents to subscribers', async () => {
    stream = new StoreBackedEventStream(mock.store, 'test-key');
    const received: StreamEntry[] = [];
    stream.subscribe((entry) => received.push(entry));

    stream.startSubscription();

    const event = makeEvent('evt-1', 'tick', { result: 'ok' });
    mock.pushEvent(event);

    // Allow microtask queue to flush
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('evt-1');
    expect(received[0].event).toBe('tick');
    expect(received[0].data).toEqual({ result: 'ok' });
    expect(received[0].ts).toBe(new Date(event.timestamp).toISOString());
  });

  it('delivers multiple events in order', async () => {
    stream = new StoreBackedEventStream(mock.store, 'test-key');
    const received: StreamEntry[] = [];
    stream.subscribe((entry) => received.push(entry));

    stream.startSubscription();

    mock.pushEvent(makeEvent('e1', 'a'));
    await new Promise((r) => setTimeout(r, 10));
    mock.pushEvent(makeEvent('e2', 'b'));
    await new Promise((r) => setTimeout(r, 10));
    mock.pushEvent(makeEvent('e3', 'c'));
    await new Promise((r) => setTimeout(r, 10));

    expect(received.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('passes fromId to readEvents when startSubscription is called with an argument', async () => {
    stream = new StoreBackedEventStream(mock.store, 'test-key');
    stream.startSubscription('last-known-id');

    expect(mock.getLastFromId()).toBe('last-known-id');
  });

  it('replaySince returns buffered events after lastId', async () => {
    stream = new StoreBackedEventStream(mock.store, 'test-key');
    stream.startSubscription();

    mock.pushEvent(makeEvent('r1', 'a'));
    mock.pushEvent(makeEvent('r2', 'b'));
    await new Promise((r) => setTimeout(r, 20));
    mock.pushEvent(makeEvent('r3', 'c'));
    await new Promise((r) => setTimeout(r, 20));

    const result = stream.replaySince('r1');
    expect(result).not.toBeNull();
    expect(result!.map((e) => e.id)).toEqual(['r2', 'r3']);
  });

  it('replaySince returns all events when lastId is "0"', async () => {
    stream = new StoreBackedEventStream(mock.store, 'test-key');
    stream.startSubscription();

    mock.pushEvent(makeEvent('a1', 'x'));
    mock.pushEvent(makeEvent('a2', 'y'));
    await new Promise((r) => setTimeout(r, 20));

    const result = stream.replaySince('0');
    expect(result).not.toBeNull();
    expect(result!.map((e) => e.id)).toEqual(['a1', 'a2']);
  });

  it('replaySince returns null when lastId is not in buffer (gap)', async () => {
    stream = new StoreBackedEventStream(mock.store, 'test-key');
    stream.startSubscription();

    mock.pushEvent(makeEvent('g2', 'x'));
    await new Promise((r) => setTimeout(r, 20));

    const result = stream.replaySince('g1');
    expect(result).toBeNull();
  });

  it('replaySince returns empty array when buffer is empty', () => {
    stream = new StoreBackedEventStream(mock.store, 'test-key');
    const result = stream.replaySince('0');
    expect(result).toEqual([]);
  });

  it('push is a no-op and does not dispatch to subscribers', () => {
    stream = new StoreBackedEventStream(mock.store, 'test-key');
    const received: StreamEntry[] = [];
    stream.subscribe((entry) => received.push(entry));

    const entry = stream.push('test', { foo: 'bar' });
    expect(entry.id).toBe('0');
    expect(received).toHaveLength(0);
  });

  it('stop prevents further events from being dispatched', async () => {
    stream = new StoreBackedEventStream(mock.store, 'test-key');
    const received: StreamEntry[] = [];
    stream.subscribe((entry) => received.push(entry));

    stream.startSubscription();

    mock.pushEvent(makeEvent('s1', 'before'));
    await new Promise((r) => setTimeout(r, 20));

    stream.stop();

    mock.pushEvent(makeEvent('s2', 'after'));
    await new Promise((r) => setTimeout(r, 20));

    expect(received.map((e) => e.id)).toEqual(['s1']);
  });

  it('evicts oldest entries when capacity is exceeded', async () => {
    stream = new StoreBackedEventStream(mock.store, 'test-key', 3);
    stream.startSubscription();

    mock.pushEvent(makeEvent('c1', 'a'));
    mock.pushEvent(makeEvent('c2', 'b'));
    await new Promise((r) => setTimeout(r, 20));
    mock.pushEvent(makeEvent('c3', 'c'));
    mock.pushEvent(makeEvent('c4', 'd'));
    await new Promise((r) => setTimeout(r, 20));

    // Buffer should only hold the last 3 entries
    const result = stream.replaySince('0');
    expect(result).not.toBeNull();
    expect(result!.map((e) => e.id)).toEqual(['c2', 'c3', 'c4']);
  });

  it('latestId tracks the most recent buffered event', async () => {
    stream = new StoreBackedEventStream(mock.store, 'test-key');
    expect(stream.latestId).toBe('0');

    stream.startSubscription();

    mock.pushEvent(makeEvent('l1', 'a'));
    await new Promise((r) => setTimeout(r, 20));
    expect(stream.latestId).toBe('l1');

    mock.pushEvent(makeEvent('l2', 'b'));
    await new Promise((r) => setTimeout(r, 20));
    expect(stream.latestId).toBe('l2');
  });

  it('unsubscribe removes the listener', async () => {
    stream = new StoreBackedEventStream(mock.store, 'test-key');
    const received: StreamEntry[] = [];
    const unsub = stream.subscribe((entry) => received.push(entry));

    stream.startSubscription();

    mock.pushEvent(makeEvent('u1', 'a'));
    await new Promise((r) => setTimeout(r, 20));

    unsub();

    mock.pushEvent(makeEvent('u2', 'b'));
    await new Promise((r) => setTimeout(r, 20));

    expect(received.map((e) => e.id)).toEqual(['u1']);
  });
});
