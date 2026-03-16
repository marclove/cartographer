import { describe, it, expect } from 'vitest';
import { InMemoryStateStore } from './in-memory-state-store.js';
import type { TreeEvent } from './state-store.js';

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
});
