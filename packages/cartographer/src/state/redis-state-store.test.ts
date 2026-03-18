import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisStateStore } from './redis-state-store.js';
import type { TreeEvent } from './state-store.js';

function createMockRedis() {
  const pipelineMethods = {
    xadd: vi.fn().mockReturnThis(),
    xtrim: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };

  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    keys: vi.fn().mockResolvedValue([]),
    eval: vi.fn().mockResolvedValue(1),
    pipeline: vi.fn().mockReturnValue(pipelineMethods),
    xrange: vi.fn().mockResolvedValue([]),
    xread: vi.fn().mockResolvedValue(null),
    duplicate: vi.fn().mockReturnValue({
      xread: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn(),
    }),
    quit: vi.fn().mockResolvedValue('OK'),
    _pipeline: pipelineMethods,
  };
}

describe('RedisStateStore', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let store: RedisStateStore;

  beforeEach(() => {
    redis = createMockRedis();
    store = new RedisStateStore({ redis });
  });

  describe('state', () => {
    const sampleState = {
      blackboard: { x: 1 },
      treeState: { rootHash: 'abc', nodes: {} },
      createdAt: 1000,
      lastMessageAt: 2000,
    };

    it('returns null when Redis returns null', async () => {
      redis.get.mockResolvedValue(null);
      expect(await store.getState('sess1')).toBeNull();
    });

    it('returns parsed JSON when Redis returns a string', async () => {
      redis.get.mockResolvedValue(JSON.stringify(sampleState));
      const result = await store.getState('sess1');
      expect(result).toEqual(sampleState);
    });

    it('uses correct prefixed key format', async () => {
      await store.getState('sess1');
      expect(redis.get).toHaveBeenCalledWith('cartographer:state:sess1');
    });

    it('serializes and stores via SET', async () => {
      await store.saveState('sess1', sampleState);
      expect(redis.set).toHaveBeenCalledWith(
        'cartographer:state:sess1',
        JSON.stringify(sampleState),
      );
    });

    it('deletes both state and events keys', async () => {
      await store.deleteState('sess1');
      expect(redis.del).toHaveBeenCalledWith(
        'cartographer:state:sess1',
        'cartographer:events:sess1',
      );
    });

    it('returns keys with prefix stripped', async () => {
      redis.keys.mockResolvedValue([
        'cartographer:state:sess1',
        'cartographer:state:sess2',
      ]);
      const keys = await store.listKeys();
      expect(keys).toEqual(['sess1', 'sess2']);
      expect(redis.keys).toHaveBeenCalledWith('cartographer:state:*');
    });
  });

  describe('locking', () => {
    it('returns true on successful NX set', async () => {
      redis.set.mockResolvedValue('OK');
      const acquired = await store.acquireLock('sess1', 'req-1', 30000);
      expect(acquired).toBe(true);
      expect(redis.set).toHaveBeenCalledWith(
        'cartographer:lock:sess1',
        'req-1',
        'PX',
        30000,
        'NX',
      );
    });

    it('returns false when lock already held', async () => {
      redis.set.mockResolvedValue(null);
      const acquired = await store.acquireLock('sess1', 'req-2', 30000);
      expect(acquired).toBe(false);
    });

    it('calls eval with Lua script and correct args', async () => {
      await store.releaseLock('sess1', 'req-1');
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("get", KEYS[1])'),
        1,
        'cartographer:lock:sess1',
        'req-1',
      );
    });
  });

  describe('events', () => {
    const events: TreeEvent[] = [
      { id: 'e1', type: 'action', data: { foo: 'bar' }, timestamp: 1000 },
      { id: 'e2', type: 'condition', data: null, timestamp: 2000 },
    ];

    it('pipelines XADD + XTRIM for appendEvents', async () => {
      await store.appendEvents('sess1', events);

      const pipe = redis._pipeline;
      expect(redis.pipeline).toHaveBeenCalled();
      expect(pipe.xadd).toHaveBeenCalledTimes(2);
      expect(pipe.xadd).toHaveBeenCalledWith(
        'cartographer:events:sess1', '*',
        'id', 'e1',
        'type', 'action',
        'data', JSON.stringify({ foo: 'bar' }),
        'timestamp', '1000',
      );
      expect(pipe.xadd).toHaveBeenCalledWith(
        'cartographer:events:sess1', '*',
        'id', 'e2',
        'type', 'condition',
        'data', JSON.stringify(null),
        'timestamp', '2000',
      );
      expect(pipe.xtrim).toHaveBeenCalledWith(
        'cartographer:events:sess1', 'MAXLEN', '~', '10000',
      );
      expect(pipe.exec).toHaveBeenCalled();
    });

    it('replays existing events via XRANGE from 0', async () => {
      redis.xrange.mockResolvedValue([
        ['1-0', ['id', 'e1', 'type', 'action', 'data', '{"foo":"bar"}', 'timestamp', '1000']],
      ]);

      const collected: TreeEvent[] = [];
      const iter = store.readEvents('sess1')[Symbol.asyncIterator]();
      const first = await iter.next();
      if (!first.done) collected.push(first.value);

      expect(redis.xrange).toHaveBeenCalledWith('cartographer:events:sess1', '-', '+');
      expect(collected).toEqual([
        { id: 'e1', type: 'action', data: { foo: 'bar' }, timestamp: 1000 },
      ]);
    });

    it('replays from exclusive lastEventId via XRANGE', async () => {
      redis.xrange.mockResolvedValue([
        ['2-0', ['id', 'e2', 'type', 'test', 'data', '"hello"', 'timestamp', '2000']],
      ]);

      const collected: TreeEvent[] = [];
      const iter = store.readEvents('sess1', '1-0')[Symbol.asyncIterator]();
      const first = await iter.next();
      if (!first.done) collected.push(first.value);

      expect(redis.xrange).toHaveBeenCalledWith('cartographer:events:sess1', '(1-0', '+');
      expect(collected).toEqual([
        { id: 'e2', type: 'test', data: 'hello', timestamp: 2000 },
      ]);
    });
  });

  describe('lifecycle', () => {
    it('close calls redis.quit()', async () => {
      await store.close();
      expect(redis.quit).toHaveBeenCalled();
    });
  });

  describe('custom prefix', () => {
    it('applies custom prefix to all keys', async () => {
      const customStore = new RedisStateStore({ redis, keyPrefix: 'myapp:' });
      const state = {
        blackboard: {},
        treeState: { rootHash: '', nodes: {} },
        createdAt: 0,
        lastMessageAt: 0,
      };

      await customStore.getState('k');
      expect(redis.get).toHaveBeenCalledWith('myapp:state:k');

      await customStore.saveState('k', state);
      expect(redis.set).toHaveBeenCalledWith('myapp:state:k', expect.any(String));

      await customStore.deleteState('k');
      expect(redis.del).toHaveBeenCalledWith('myapp:state:k', 'myapp:events:k');

      redis.keys.mockResolvedValue(['myapp:state:k']);
      const keys = await customStore.listKeys();
      expect(keys).toEqual(['k']);

      await customStore.acquireLock('k', 'r', 1000);
      expect(redis.set).toHaveBeenCalledWith('myapp:lock:k', 'r', 'PX', 1000, 'NX');

      await customStore.releaseLock('k', 'r');
      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        'myapp:lock:k',
        'r',
      );
    });
  });
});
