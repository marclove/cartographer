# Task 46: SSE Event Buffer

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a ring buffer that stores serialized SSE events with incrementing IDs, supporting `Last-Event-ID` reconnection.

**Depends on:** Task 45

---

### Step 1: Write failing tests

Create `src/server/event-buffer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { EventBuffer } from './event-buffer.js';

describe('EventBuffer', () => {
  it('stores events with incrementing IDs', () => {
    const buf = new EventBuffer(100);
    buf.push('node:enter', { node: { id: 'a' } });
    buf.push('node:exit', { node: { id: 'a' }, status: 'success' });

    const events = buf.getEventsSince(0);
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe(1);
    expect(events[0].event).toBe('node:enter');
    expect(events[1].id).toBe(2);
    expect(events[1].event).toBe('node:exit');
  });

  it('getEventsSince returns events after the given ID', () => {
    const buf = new EventBuffer(100);
    buf.push('node:enter', { node: { id: 'a' } });
    buf.push('node:exit', { node: { id: 'a' } });
    buf.push('tree:tick', { status: 'success' });

    const events = buf.getEventsSince(1);
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe(2);
    expect(events[1].id).toBe(3);
  });

  it('getEventsSince(0) returns all events', () => {
    const buf = new EventBuffer(100);
    buf.push('a', { x: 1 });
    buf.push('b', { x: 2 });
    expect(buf.getEventsSince(0)).toHaveLength(2);
  });

  it('evicts oldest events when capacity exceeded', () => {
    const buf = new EventBuffer(3);
    buf.push('a', {});
    buf.push('b', {});
    buf.push('c', {});
    buf.push('d', {});

    const events = buf.getEventsSince(0);
    expect(events).toHaveLength(3);
    expect(events[0].event).toBe('b');
    expect(events[0].id).toBe(2);
  });

  it('returns null from getEventsSince when requested ID is evicted', () => {
    const buf = new EventBuffer(2);
    buf.push('a', {});
    buf.push('b', {});
    buf.push('c', {});

    // ID 1 has been evicted — return null to signal a full snapshot is needed
    expect(buf.getEventsSince(0)).toBeNull();
  });

  it('latestId returns the ID of the most recent event', () => {
    const buf = new EventBuffer(100);
    expect(buf.latestId).toBe(0);
    buf.push('a', {});
    expect(buf.latestId).toBe(1);
    buf.push('b', {});
    expect(buf.latestId).toBe(2);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/server/event-buffer.test.ts`
Expected: FAIL — module `./event-buffer.js` does not exist.

### Step 3: Implement EventBuffer

Create `src/server/event-buffer.ts`:

```ts
export interface BufferedEvent {
  id: number;
  event: string;
  data: Record<string, unknown>;
  ts: string;
}

export class EventBuffer {
  private buffer: BufferedEvent[] = [];
  private nextId = 1;

  constructor(private readonly capacity: number) {}

  get latestId(): number {
    return this.nextId - 1;
  }

  push(event: string, data: Record<string, unknown>): BufferedEvent {
    const entry: BufferedEvent = {
      id: this.nextId++,
      event,
      data,
      ts: new Date().toISOString(),
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
    return entry;
  }

  /**
   * Returns events after `lastId`, or null if the requested ID
   * has been evicted from the buffer (caller should send a full snapshot).
   */
  getEventsSince(lastId: number): BufferedEvent[] | null {
    if (this.buffer.length === 0) return [];

    const oldestId = this.buffer[0].id;
    if (lastId > 0 && lastId < oldestId) {
      return null; // Requested events have been evicted
    }

    return this.buffer.filter((e) => e.id > lastId);
  }
}
```

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/server/event-buffer.test.ts`
Expected: All pass.

### Step 5: Typecheck

Run: `npm run typecheck`
Expected: All pass.

### Step 6: Commit

```bash
git add src/server/event-buffer.ts src/server/event-buffer.test.ts
git commit -m "feat(server): add SSE event ring buffer with reconnection support"
```
