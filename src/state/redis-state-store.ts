/**
 * Redis-backed StateStore for production deployments.
 *
 * Uses:
 * - GET/SET with JSON serialization for state
 * - SET NX EX for locking with Lua release script (validates requestId ownership)
 * - Redis Streams (XADD, XREAD BLOCK, XTRIM) for durable event delivery
 *
 * Requires `ioredis` as a peer dependency.
 *
 * @example
 * ```ts
 * import Redis from 'ioredis';
 * const store = new RedisStateStore({ redis: new Redis() });
 * ```
 */

import type { StateStore, TreeSessionState, TreeEvent } from './state-store.js';

export interface RedisStateStoreOptions {
  /** An existing ioredis instance. */
  redis: any;
  /** Maximum events to retain per stream. Defaults to 1000. */
  maxEvents?: number;
  /** Key prefix for all Redis keys. Defaults to 'cartographer:'. */
  keyPrefix?: string;
}

export class RedisStateStore implements StateStore {
  private redis: any;
  private maxEvents: number;
  private keyPrefix: string;

  constructor(options: RedisStateStoreOptions) {
    this.redis = options.redis;
    this.maxEvents = options.maxEvents ?? 1000;
    this.keyPrefix = options.keyPrefix ?? 'cartographer:';
  }

  private stateKey(key: string): string { return `${this.keyPrefix}state:${key}`; }
  private lockKey(key: string): string { return `${this.keyPrefix}lock:${key}`; }
  private eventsKey(key: string): string { return `${this.keyPrefix}events:${key}`; }

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
    const keys: string[] = await this.redis.keys(pattern);
    return keys.map(k => k.slice(`${this.keyPrefix}state:`.length));
  }

  async acquireLock(key: string, requestId: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(
      this.lockKey(key), requestId, 'PX', ttlMs, 'NX'
    );
    return result === 'OK';
  }

  async releaseLock(key: string, requestId: string): Promise<void> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await this.redis.eval(script, 1, this.lockKey(key), requestId);
  }

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
    let cursor = lastEventId ?? '0';

    const existing = await this.redis.xrange(
      this.eventsKey(key),
      cursor === '0' ? '-' : `(${cursor}`,
      '+'
    );
    for (const [streamId, fields] of existing) {
      yield this.parseStreamEntry(streamId, fields);
      cursor = streamId;
    }

    const subscriber = this.redis.duplicate();
    try {
      while (true) {
        const result = await subscriber.xread('BLOCK', 5000, 'STREAMS', this.eventsKey(key), cursor);
        if (!result) continue;

        for (const [, entries] of result) {
          for (const [streamId, fields] of entries) {
            yield this.parseStreamEntry(streamId, fields);
            cursor = streamId;
          }
        }
      }
    } finally {
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

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
