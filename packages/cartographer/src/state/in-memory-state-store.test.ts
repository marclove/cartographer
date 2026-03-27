import { describe, it, expect } from 'vitest';
import { InMemoryStateStore } from './in-memory-state-store.js';
import type { TreeEvent } from './state-store.js';
import type { ActorMessage } from '../actor/types.js';

describe('InMemoryStateStore', () => {
  describe('state', () => {
    it('stores and retrieves state', async () => {
      const store = new InMemoryStateStore();
      const state = { blackboard: { x: 1 }, treeState: { rootHash: 'abc', nodes: {} }, createdAt: Date.now(), lastMessageAt: Date.now() };
      await store.saveState('key', state);
      const retrieved = await store.getState('key');
      expect(retrieved).toEqual(state);
    });

    it('returns null for missing key', async () => {
      const store = new InMemoryStateStore();
      expect(await store.getState('missing')).toBeNull();
    });

    it('deep clones on save (no shared references)', async () => {
      const store = new InMemoryStateStore();
      const state = { blackboard: { x: 1 }, treeState: { rootHash: 'abc', nodes: {} }, createdAt: 0, lastMessageAt: 0 };
      await store.saveState('key', state);
      state.blackboard.x = 999;
      const retrieved = await store.getState('key');
      expect(retrieved!.blackboard.x).toBe(1);
    });

    it('lists keys', async () => {
      const store = new InMemoryStateStore();
      await store.saveState('a', { blackboard: {}, treeState: { rootHash: '', nodes: {} }, createdAt: 0, lastMessageAt: 0 });
      await store.saveState('b', { blackboard: {}, treeState: { rootHash: '', nodes: {} }, createdAt: 0, lastMessageAt: 0 });
      expect(await store.listKeys()).toEqual(expect.arrayContaining(['a', 'b']));
    });

    it('deletes state and events', async () => {
      const store = new InMemoryStateStore();
      await store.saveState('key', { blackboard: {}, treeState: { rootHash: '', nodes: {} }, createdAt: 0, lastMessageAt: 0 });
      await store.deleteState('key');
      expect(await store.getState('key')).toBeNull();
    });
  });

  describe('clearHeld', () => {
    it('clears held flag and returns true when held', async () => {
      const store = new InMemoryStateStore();
      await store.saveState('key', { blackboard: {}, treeState: { rootHash: '', nodes: {} }, createdAt: 0, lastMessageAt: 0, held: true });
      expect(await store.clearHeld('key')).toBe(true);
      const state = await store.getState('key');
      expect(state?.held).toBe(false);
    });

    it('returns false when not held', async () => {
      const store = new InMemoryStateStore();
      await store.saveState('key', { blackboard: {}, treeState: { rootHash: '', nodes: {} }, createdAt: 0, lastMessageAt: 0 });
      expect(await store.clearHeld('key')).toBe(false);
    });

    it('returns false when no state exists', async () => {
      const store = new InMemoryStateStore();
      expect(await store.clearHeld('missing')).toBe(false);
    });
  });

  describe('locking', () => {
    it('acquires lock when not held', async () => {
      const store = new InMemoryStateStore();
      expect(await store.acquireLock('key', 'req1', 30000)).toBe(true);
    });

    it('rejects lock when already held', async () => {
      const store = new InMemoryStateStore();
      await store.acquireLock('key', 'req1', 30000);
      expect(await store.acquireLock('key', 'req2', 30000)).toBe(false);
    });

    it('releases lock with matching requestId', async () => {
      const store = new InMemoryStateStore();
      await store.acquireLock('key', 'req1', 30000);
      await store.releaseLock('key', 'req1');
      expect(await store.acquireLock('key', 'req2', 30000)).toBe(true);
    });

    it('renews lock when held by same requestId', async () => {
      const store = new InMemoryStateStore();
      await store.acquireLock('key', 'req1', 30000);
      expect(await store.renewLock('key', 'req1', 30000)).toBe(true);
    });

    it('rejects renewal when held by different requestId', async () => {
      const store = new InMemoryStateStore();
      await store.acquireLock('key', 'req1', 30000);
      expect(await store.renewLock('key', 'req2', 30000)).toBe(false);
    });

    it('rejects renewal when no lock exists', async () => {
      const store = new InMemoryStateStore();
      expect(await store.renewLock('key', 'req1', 30000)).toBe(false);
    });

    it('does not release lock with wrong requestId', async () => {
      const store = new InMemoryStateStore();
      await store.acquireLock('key', 'req1', 30000);
      await store.releaseLock('key', 'wrong');
      expect(await store.acquireLock('key', 'req2', 30000)).toBe(false);
    });
  });

  describe('events', () => {
    it('appends and reads events', async () => {
      const store = new InMemoryStateStore();
      await store.appendEvents('key', [
        { id: '1', type: 'test', data: 'a', timestamp: 1 },
        { id: '2', type: 'test', data: 'b', timestamp: 2 },
      ]);

      const events: TreeEvent[] = [];
      const iter = store.readEvents('key')[Symbol.asyncIterator]();
      events.push((await iter.next()).value);
      events.push((await iter.next()).value);
      expect(events.map(e => e.id)).toEqual(['1', '2']);
    });

    it('replays from lastEventId', async () => {
      const store = new InMemoryStateStore();
      await store.appendEvents('key', [
        { id: '1', type: 'test', data: 'a', timestamp: 1 },
        { id: '2', type: 'test', data: 'b', timestamp: 2 },
        { id: '3', type: 'test', data: 'c', timestamp: 3 },
      ]);

      const events: TreeEvent[] = [];
      const iter = store.readEvents('key', '1')[Symbol.asyncIterator]();
      events.push((await iter.next()).value);
      events.push((await iter.next()).value);
      expect(events.map(e => e.id)).toEqual(['2', '3']);
    });

    it('trims events beyond maxEvents', async () => {
      const store = new InMemoryStateStore({ maxEvents: 3 });
      await store.appendEvents('key', [
        { id: '1', type: 'test', data: 'a', timestamp: 1 },
        { id: '2', type: 'test', data: 'b', timestamp: 2 },
        { id: '3', type: 'test', data: 'c', timestamp: 3 },
        { id: '4', type: 'test', data: 'd', timestamp: 4 },
      ]);

      const events: TreeEvent[] = [];
      const iter = store.readEvents('key')[Symbol.asyncIterator]();
      events.push((await iter.next()).value);
      events.push((await iter.next()).value);
      events.push((await iter.next()).value);
      expect(events.map(e => e.id)).toEqual(['2', '3', '4']);
    });
  });

  describe('queue', () => {
    it('enqueueMessage stores and returns position', async () => {
      const store = new InMemoryStateStore();
      const msg1: ActorMessage = { type: 'command', name: 'a' };
      const msg2: ActorMessage = { type: 'command', name: 'b' };
      const msg3: ActorMessage = { type: 'command', name: 'c' };

      const r1 = await store.enqueueMessage('default', msg1, 10);
      const r2 = await store.enqueueMessage('default', msg2, 10);
      const r3 = await store.enqueueMessage('default', msg3, 10);

      expect(r1.position).toBe(1);
      expect(r2.position).toBe(2);
      expect(r3.position).toBe(3);
    });

    it('dequeueMessage returns messages in FIFO order', async () => {
      const store = new InMemoryStateStore();
      const msg1: ActorMessage = { type: 'command', name: 'first' };
      const msg2: ActorMessage = { type: 'command', name: 'second' };
      await store.enqueueMessage('default', msg1, 10);
      await store.enqueueMessage('default', msg2, 10);

      const d1 = await store.dequeueMessage('default');
      const d2 = await store.dequeueMessage('default');

      expect(d1).toEqual(msg1);
      expect(d2).toEqual(msg2);
    });

    it('dequeueMessage returns null for empty queue', async () => {
      const store = new InMemoryStateStore();
      expect(await store.dequeueMessage('default')).toBeNull();
    });

    it('enqueueMessage throws when queue is full', async () => {
      const store = new InMemoryStateStore();
      await store.enqueueMessage('default', { type: 'tick' }, 2);
      await store.enqueueMessage('default', { type: 'tick' }, 2);

      await expect(store.enqueueMessage('default', { type: 'tick' }, 2))
        .rejects.toThrow('Queue full');
    });

    it('getQueueSize returns correct count', async () => {
      const store = new InMemoryStateStore();
      expect(await store.getQueueSize('default')).toBe(0);
      await store.enqueueMessage('default', { type: 'tick' }, 10);
      expect(await store.getQueueSize('default')).toBe(1);
      await store.enqueueMessage('default', { type: 'tick' }, 10);
      expect(await store.getQueueSize('default')).toBe(2);
      await store.dequeueMessage('default');
      expect(await store.getQueueSize('default')).toBe(1);
    });

    it('getQueuedMessages returns all queued messages', async () => {
      const store = new InMemoryStateStore();
      const msgs: ActorMessage[] = [
        { type: 'command', name: 'a' },
        { type: 'command', name: 'b' },
        { type: 'command', name: 'c' },
      ];
      for (const msg of msgs) await store.enqueueMessage('default', msg, 10);

      expect(await store.getQueuedMessages('default')).toEqual(msgs);
    });

    it('getQueuedMessages returns empty array for missing key', async () => {
      const store = new InMemoryStateStore();
      expect(await store.getQueuedMessages('nonexistent')).toEqual([]);
    });

    it('deleteState also clears the queue', async () => {
      const store = new InMemoryStateStore();
      await store.enqueueMessage('default', { type: 'tick' }, 10);
      await store.deleteState('default');
      expect(await store.getQueueSize('default')).toBe(0);
      expect(await store.dequeueMessage('default')).toBeNull();
    });

    it('listQueuedKeys returns keys with non-empty queues', async () => {
      const store = new InMemoryStateStore();
      await store.enqueueMessage('a', { type: 'tick' }, 10);
      await store.enqueueMessage('b', { type: 'tick' }, 10);

      const keys = await store.listQueuedKeys();
      expect(keys).toEqual(expect.arrayContaining(['a', 'b']));
      expect(keys).toHaveLength(2);
    });

    it('listQueuedKeys excludes empty queues', async () => {
      const store = new InMemoryStateStore();
      await store.enqueueMessage('full', { type: 'tick' }, 10);
      await store.enqueueMessage('drained', { type: 'tick' }, 10);
      await store.dequeueMessage('drained');

      const keys = await store.listQueuedKeys();
      expect(keys).toEqual(['full']);
    });
  });
});
