# Task 49: SSE Stream Endpoint

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Test and finalize the SSE stream endpoint (`GET /api/events`) — snapshot on connect, live event streaming, and `Last-Event-ID` reconnection.

**Depends on:** Task 47, Task 48

---

### Step 1: Write SSE integration tests

Create `src/server/__integration__/sse-stream.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DashboardServer } from '../dashboard-server.js';
import { BehaviorTree } from '../../core/behavior-tree.js';
import { InMemoryBlackboard } from '../../core/blackboard.js';
import { ActionNode } from '../../nodes/action.js';
import { SequenceNode } from '../../composites/sequence.js';
import { NodeStatus } from '../../types.js';

let server: DashboardServer;
let port: number;
let tree: BehaviorTree;

function createTree() {
  const act = new ActionNode({
    name: 'Work',
    id: 'work',
    action: async (ctx) => {
      ctx.blackboard.set('result', 'done');
      return NodeStatus.SUCCESS;
    },
  });
  const root = new SequenceNode({ name: 'Root', id: 'root', children: [act] });
  return new BehaviorTree({ name: 'SSETree', root, blackboard: new InMemoryBlackboard() });
}

/** Collects SSE events from a stream until `count` events received or `timeoutMs` elapsed. */
async function collectSSEEvents(
  url: string,
  count: number,
  timeoutMs = 3000,
  headers?: Record<string, string>,
): Promise<Array<{ event: string; data: any; id?: string }>> {
  const events: Array<{ event: string; data: any; id?: string }> = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE messages (double newline delimited)
      const parts = buffer.split('\n\n');
      buffer = parts.pop()!;
      for (const part of parts) {
        if (!part.trim()) continue;
        const lines = part.split('\n');
        let event = '';
        let data = '';
        let id = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data = line.slice(6);
          else if (line.startsWith('id: ')) id = line.slice(4);
        }
        if (event && data) {
          events.push({ event, data: JSON.parse(data), id: id || undefined });
        }
      }
    }
    reader.cancel();
  } catch {
    // AbortError is expected on timeout
  } finally {
    clearTimeout(timeout);
  }

  return events;
}

beforeAll(async () => {
  tree = createTree();
  server = new DashboardServer(tree, { port: 0 });
  ({ port } = await server.start());
});

afterAll(async () => {
  await server.close();
});

describe('GET /api/events', () => {
  it('sends snapshot event on connect', async () => {
    const events = await collectSSEEvents(`http://localhost:${port}/api/events`, 1);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('snapshot');
    expect(events[0].data.tree).toBeDefined();
    expect(events[0].data.tree.name).toBe('SSETree');
    expect(events[0].data.blackboard).toBeDefined();
  });

  it('streams live events when tree ticks', async () => {
    // Start collecting — snapshot + node:enter + node:exit + blackboard:write + tree:tick = 5+
    const eventsPromise = collectSSEEvents(`http://localhost:${port}/api/events`, 6, 3000);

    // Give SSE connection time to establish
    await new Promise((r) => setTimeout(r, 50));
    await tree.tick();

    const events = await eventsPromise;
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0].event).toBe('snapshot');

    const eventNames = events.map((e) => e.event);
    expect(eventNames).toContain('tree:tick');
  });

  it('events include incrementing IDs', async () => {
    const eventsPromise = collectSSEEvents(`http://localhost:${port}/api/events`, 6, 3000);
    await new Promise((r) => setTimeout(r, 50));
    tree.reset();
    await tree.tick();
    const events = await eventsPromise;

    const withIds = events.filter((e) => e.id);
    // Snapshot has no id, but live events do
    expect(withIds.length).toBeGreaterThan(0);
    const ids = withIds.map((e) => parseInt(e.id!, 10));
    // IDs should be monotonically increasing
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  it('replays missed events on reconnect with Last-Event-ID', async () => {
    // First, generate some events
    tree.reset();
    await tree.tick();

    // Connect with Last-Event-ID = 0 to get all buffered events after snapshot
    const events = await collectSSEEvents(
      `http://localhost:${port}/api/events`,
      10,
      2000,
      { 'Last-Event-ID': '0' },
    );

    expect(events[0].event).toBe('snapshot');
    // Should have replayed events after snapshot
    expect(events.length).toBeGreaterThan(1);
  });
});
```

### Step 2: Run tests

Run: `npx vitest run src/server/__integration__/sse-stream.test.ts`
Expected: All pass (using SSE handler stubbed in Task 47).

If any fail, adjust `src/server/sse-handler.ts` to match. Key behaviors: snapshot on connect, `id:` field on all live events, `Last-Event-ID` replay.

### Step 3: Typecheck

Run: `npm run typecheck`
Expected: All pass.

### Step 4: Commit

```bash
git add src/server/__integration__/sse-stream.test.ts src/server/sse-handler.ts
git commit -m "test(server): add SSE stream integration tests with reconnection"
```
