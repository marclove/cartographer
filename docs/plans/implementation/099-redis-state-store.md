# Task 99: RedisStateStore

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement RedisStateStore — production StateStore backed by Redis for state persistence, SET-based locking with heartbeat, and Redis Streams for durable event delivery.

**Depends on:** Task 093 (StateStore interface)

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Sections 1 (Locking), 2 (StateStore), 3 (SSE Event Delivery)

---

### Context

Redis is already used by the PaaS and self-hosted production deployments. The RedisStateStore wraps:
- State: `GET`/`SET` with JSON serialization, keyed as `state:{key}`
- Locking: `SET NX EX` with Lua release script (validates requestId ownership)
- Events: Redis Streams (`XADD`, `XREAD BLOCK`, `XTRIM MAXLEN`)

**Important:** `readEvents()` returns an AsyncIterable. The teardown must explicitly close the `XREAD BLOCK` loop and release the Redis connection when the consumer breaks out (SSE client disconnect). Use `try/finally` in the async generator.

### Step 1: Add ioredis dependency

```bash
npm install ioredis
npm install -D @types/ioredis  # if needed
```

Check if ioredis is already a dependency. If the project uses a different Redis client, use that instead.

### Step 2: Implement RedisStateStore

Create `src/state/redis-state-store.ts`:

```ts
import Redis from 'ioredis';
import type { StateStore, TreeSessionState, TreeEvent } from './state-store.js';

export interface RedisStateStoreOptions {
  url?: string;
  redis?: Redis;
  maxEvents?: number;
  keyPrefix?: string;
}

export class RedisStateStore implements StateStore {
  private redis: Redis;
  private maxEvents: number;
  private keyPrefix: string;

  constructor(options: RedisStateStoreOptions = {}) {
    this.redis = options.redis ?? new Redis(options.url ?? 'redis://localhost:6379');
    this.maxEvents = options.maxEvents ?? 1000;
    this.keyPrefix = options.keyPrefix ?? 'cartographer:';
  }

  private stateKey(key: string): string { return `${this.keyPrefix}state:${key}`; }
  private lockKey(key: string): string { return `${this.keyPrefix}lock:${key}`; }
  private eventsKey(key: string): string { return `${this.keyPrefix}events:${key}`; }

  // --- State ---

  async getState(key: string): Promise<TreeSessionState | null> {
    const raw = await this.redis.get(this.stateKey(key));
    return raw ? JSON.parse(raw) : null;
  }

  async saveState(key: string, state: TreeSessionState): Promise<void> {
    await this.redis.set(this.stateKey(key), JSON.stringify(state));
  }

  async deleteState(key: string): Promise<void> {
    await this.redis.del(this.stateKey(key), this.eventsKey(key));
  }

  async listKeys(): Promise<string[]> {
    const pattern = `${this.keyPrefix}state:*`;
    const keys = await this.redis.keys(pattern);
    return keys.map(k => k.slice(`${this.keyPrefix}state:`.length));
  }

  // --- Locking ---

  async acquireLock(key: string, requestId: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(
      this.lockKey(key), requestId, 'PX', ttlMs, 'NX'
    );
    return result === 'OK';
  }

  async releaseLock(key: string, requestId: string): Promise<void> {
    // Lua script: only release if requestId matches
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await this.redis.eval(script, 1, this.lockKey(key), requestId);
  }

  // --- Events ---

  async appendEvents(key: string, events: TreeEvent[]): Promise<void> {
    const pipeline = this.redis.pipeline();
    for (const event of events) {
      pipeline.xadd(
        this.eventsKey(key), '*',
        'id', event.id,
        'type', event.type,
        'data', JSON.stringify(event.data),
        'timestamp', String(event.timestamp),
      );
    }
    pipeline.xtrim(this.eventsKey(key), 'MAXLEN', '~', String(this.maxEvents));
    await pipeline.exec();
  }

  async *readEvents(key: string, lastEventId?: string): AsyncIterable<TreeEvent> {
    // Resolve starting position
    let cursor = lastEventId ?? '0';

    // First: replay existing events
    const existing = await this.redis.xrange(this.eventsKey(key), cursor === '0' ? '-' : `(${cursor}`, '+');
    for (const [streamId, fields] of existing) {
      yield this.parseStreamEntry(streamId, fields);
      cursor = streamId;
    }

    // Then: block for new events
    // Use a dedicated connection for blocking reads
    const subscriber = this.redis.duplicate();
    try {
      while (true) {
        const result = await subscriber.xread('BLOCK', 5000, 'STREAMS', this.eventsKey(key), cursor);
        if (!result) continue; // timeout, retry

        for (const [, entries] of result) {
          for (const [streamId, fields] of entries) {
            yield this.parseStreamEntry(streamId, fields);
            cursor = streamId;
          }
        }
      }
    } finally {
      // Critical: clean up the blocking connection on consumer disconnect
      subscriber.disconnect();
    }
  }

  private parseStreamEntry(streamId: string, fields: string[]): TreeEvent {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      obj[fields[i]] = fields[i + 1];
    }
    return {
      id: obj.id ?? streamId,
      type: obj.type ?? 'unknown',
      data: obj.data ? JSON.parse(obj.data) : null,
      timestamp: parseInt(obj.timestamp ?? '0', 10),
    };
  }

  /** Close the Redis connection. */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}
```

### Step 3: Write tests

Create `src/state/redis-state-store.test.ts`. These are integration tests that require a running Redis instance:

```ts
// Mark as integration tests (skip if no Redis available)
describe('RedisStateStore', () => {
  let store: RedisStateStore;

  beforeEach(() => {
    store = new RedisStateStore({
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
      keyPrefix: `test:${Date.now()}:`,
    });
  });

  afterEach(async () => {
    // Clean up test keys
    await store.close();
  });

  it('stores and retrieves state', async () => {
    const state = {
      blackboard: { x: 1 },
      treeState: { rootHash: 'abc', nodes: {} },
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
    };
    await store.saveState('key', state);
    expect(await store.getState('key')).toEqual(state);
  });

  it('acquires and releases locks', async () => {
    expect(await store.acquireLock('key', 'req1', 30000)).toBe(true);
    expect(await store.acquireLock('key', 'req2', 30000)).toBe(false);
    await store.releaseLock('key', 'req1');
    expect(await store.acquireLock('key', 'req2', 30000)).toBe(true);
  });

  it('does not release lock with wrong requestId', async () => {
    await store.acquireLock('key', 'req1', 30000);
    await store.releaseLock('key', 'wrong');
    expect(await store.acquireLock('key', 'req2', 30000)).toBe(false);
  });

  it('appends and reads events', async () => {
    await store.appendEvents('key', [
      { id: '1', type: 'test', data: { x: 1 }, timestamp: Date.now() },
    ]);

    const events: TreeEvent[] = [];
    const iter = store.readEvents('key')[Symbol.asyncIterator]();
    const { value } = await iter.next();
    events.push(value);
    expect(events[0].data).toEqual({ x: 1 });
    await iter.return?.();
  });
});
```

### Step 4: Run tests

Run: `npx vitest run src/state/redis-state-store.test.ts`
Note: These require a running Redis instance. Add to the `integration` test project.

### Step 5: Commit

```bash
git add src/state/redis-state-store.ts src/state/redis-state-store.test.ts package.json
git commit -m "feat(state): add RedisStateStore with SET locking, Lua release, and Redis Streams"
```
