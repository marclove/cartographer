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
    lpop: vi.fn(),
    llen: vi.fn().mockResolvedValue(0),
    lrange: vi.fn().mockResolvedValue([]),
    quit: vi.fn().mockResolvedValue('OK'),
    _pipeline: pipelineMethods,
  };
}

describe('RedisStateStore', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let store: RedisStateStore;
  let prefixStore: RedisStateStore;

  beforeEach(() => {
    redis = createMockRedis();
    store = new RedisStateStore({ redis });
    prefixStore = new RedisStateStore({ redis, keyPrefix: 'myapp:' });
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

    it('deletes state, events, and queue keys', async () => {
      await store.deleteState('sess1');
      expect(redis.del).toHaveBeenCalledWith(
        'cartographer:state:sess1',
        'cartographer:events:sess1',
        'cartographer:queue:sess1',
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

  describe('queue', () => {
    it('enqueueMessage calls eval with Lua script and correct args', async () => {
      redis.eval.mockResolvedValue(1);
      const msg = { type: 'command', name: 'test' };
      const result = await store.enqueueMessage('default', msg as any, 16);

      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('LLEN'),
        1,
        'cartographer:queue:default',
        16,
        JSON.stringify(msg),
      );
      expect(result).toEqual({ position: 1, queueSize: 1 });
    });

    it('enqueueMessage throws when Lua returns -1 (queue full)', async () => {
      redis.eval.mockResolvedValue(-1);
      await expect(store.enqueueMessage('default', { type: 'tick' } as any, 16))
        .rejects.toThrow('Queue full');
    });

    it('dequeueMessage calls lpop and parses result', async () => {
      const msg = { type: 'command', name: 'test' };
      redis.lpop.mockResolvedValue(JSON.stringify(msg));
      const result = await store.dequeueMessage('default');

      expect(redis.lpop).toHaveBeenCalledWith('cartographer:queue:default');
      expect(result).toEqual(msg);
    });

    it('dequeueMessage returns null when lpop returns null', async () => {
      redis.lpop.mockResolvedValue(null);
      expect(await store.dequeueMessage('default')).toBeNull();
    });

    it('getQueueSize calls llen with correct key', async () => {
      redis.llen.mockResolvedValue(3);
      const size = await store.getQueueSize('default');

      expect(redis.llen).toHaveBeenCalledWith('cartographer:queue:default');
      expect(size).toBe(3);
    });

    it('getQueuedMessages calls lrange and parses all entries', async () => {
      const msgs = [{ type: 'tick' }, { type: 'command', name: 'a' }];
      redis.lrange.mockResolvedValue(msgs.map(m => JSON.stringify(m)));
      const result = await store.getQueuedMessages('default');

      expect(redis.lrange).toHaveBeenCalledWith('cartographer:queue:default', 0, -1);
      expect(result).toEqual(msgs);
    });

    it('deleteState also deletes queue key', async () => {
      redis.del.mockResolvedValue(1);
      await store.deleteState('default');

      expect(redis.del).toHaveBeenCalledWith(
        'cartographer:state:default',
        'cartographer:events:default',
        'cartographer:queue:default',
      );
    });

    it('custom prefix applies to queue key', async () => {
      redis.eval.mockResolvedValue(1);
      await prefixStore.enqueueMessage('default', { type: 'tick' } as any, 10);

      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        'myapp:queue:default',
        10,
        expect.any(String),
      );
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
      expect(redis.del).toHaveBeenCalledWith('myapp:state:k', 'myapp:events:k', 'myapp:queue:k');

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
