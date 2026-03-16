# Task 93: StateStore Interface + InMemoryStateStore

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Define the StateStore interface and implement InMemoryStateStore for local dev.

**Depends on:** None

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Sections 1 (Locking), 2 (StateStore Interface), 3 (SSE Event Delivery)

---

### Step 1: Create the StateStore interface

Create `src/state/state-store.ts`:

```ts
import type { SerializedTreeState } from '../core/serialization.js';

export interface TreeSessionState {
  blackboard: Record<string, unknown>;
  treeState: SerializedTreeState;
  createdAt: number;
  lastMessageAt: number;
}

export interface TreeEvent {
  id: string;
  type: string;
  data: unknown;
  timestamp: number;
}

export interface StateStore {
  // Tree state
  getState(key: string): Promise<TreeSessionState | null>;
  saveState(key: string, state: TreeSessionState): Promise<void>;
  deleteState(key: string): Promise<void>;
  listKeys(): Promise<string[]>;

  // Locking
  acquireLock(key: string, requestId: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string, requestId: string): Promise<void>;

  // Event streaming
  appendEvents(key: string, events: TreeEvent[]): Promise<void>;
  readEvents(key: string, lastEventId?: string): AsyncIterable<TreeEvent>;
}
```

### Step 2: Implement InMemoryStateStore

Create `src/state/in-memory-state-store.ts`:

```ts
import type { StateStore, TreeSessionState, TreeEvent } from './state-store.js';

export class InMemoryStateStore implements StateStore {
  private store = new Map<string, TreeSessionState>();
  private locks = new Map<string, string>(); // key → requestId
  private events = new Map<string, TreeEvent[]>(); // key → event buffer
  private eventWaiters = new Map<string, Array<() => void>>(); // key → resolve callbacks
  private maxEvents: number;

  constructor(options?: { maxEvents?: number }) {
    this.maxEvents = options?.maxEvents ?? 1000;
  }

  // --- State ---

  async getState(key: string): Promise<TreeSessionState | null> {
    return this.store.get(key) ?? null;
  }

  async saveState(key: string, state: TreeSessionState): Promise<void> {
    this.store.set(key, structuredClone(state));
  }

  async deleteState(key: string): Promise<void> {
    this.store.delete(key);
    this.events.delete(key);
  }

  async listKeys(): Promise<string[]> {
    return [...this.store.keys()];
  }

  // --- Locking ---

  async acquireLock(key: string, requestId: string, _ttlMs: number): Promise<boolean> {
    if (this.locks.has(key)) return false;
    this.locks.set(key, requestId);
    return true;
  }

  async releaseLock(key: string, requestId: string): Promise<void> {
    if (this.locks.get(key) === requestId) {
      this.locks.delete(key);
    }
  }

  // --- Events ---

  async appendEvents(key: string, newEvents: TreeEvent[]): Promise<void> {
    let buffer = this.events.get(key);
    if (!buffer) {
      buffer = [];
      this.events.set(key, buffer);
    }
    buffer.push(...newEvents);
    // Trim to max capacity
    if (buffer.length > this.maxEvents) {
      buffer.splice(0, buffer.length - this.maxEvents);
    }
    // Wake any waiters
    const waiters = this.eventWaiters.get(key);
    if (waiters) {
      for (const resolve of waiters) resolve();
      this.eventWaiters.delete(key);
    }
  }

  async *readEvents(key: string, lastEventId?: string): AsyncIterable<TreeEvent> {
    const buffer = this.events.get(key) ?? [];

    // Replay from lastEventId
    let startIndex = 0;
    if (lastEventId) {
      const idx = buffer.findIndex(e => e.id === lastEventId);
      if (idx !== -1) startIndex = idx + 1;
    }
    for (let i = startIndex; i < buffer.length; i++) {
      yield buffer[i];
    }

    // Block for new events
    while (true) {
      const currentLen = (this.events.get(key) ?? []).length;
      await new Promise<void>(resolve => {
        let waiters = this.eventWaiters.get(key);
        if (!waiters) {
          waiters = [];
          this.eventWaiters.set(key, waiters);
        }
        waiters.push(resolve);
      });

      const allEvents = this.events.get(key) ?? [];
      for (let i = currentLen; i < allEvents.length; i++) {
        yield allEvents[i];
      }
    }
  }
}
```

### Step 3: Write tests

Create `src/state/in-memory-state-store.test.ts`:

```ts
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
```

### Step 4: Run tests

Run: `npx vitest run src/state/`
Expected: All pass.

### Step 5: Typecheck

Run: `npm run typecheck`

### Step 6: Commit

```bash
git add src/state/state-store.ts src/state/in-memory-state-store.ts src/state/in-memory-state-store.test.ts
git commit -m "feat(state): add StateStore interface and InMemoryStateStore implementation"
```
