# Task 105: Add Real-Time SSE Broadcasting to ActorServer

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a dashboard-compatible `/events` SSE endpoint to ActorServer with real-time event broadcasting, EventBuffer for reconnection, and numeric event IDs.

**Depends on:** Task 102 (EventBridge onEvent), Task 104 (read endpoints + trackEvent)

---

### Context

The dashboard connects to `/events` (not `/api/events`) and expects:
- SSE snapshot: `{ tree: TreeNode, blackboard: Record<string, unknown> }`
- Numeric auto-incrementing event IDs (dashboard parses with `parseInt`)
- Real-time event streaming during message processing

ActorServer currently has `/api/events` backed by StateStore's `readEvents()` (string IDs, batched). We need a *separate* `/events` endpoint that uses an in-memory EventBuffer (like TreeServer) for real-time dashboard streaming. The existing `/api/events` stays for programmatic/historical consumers.

During `processAsync`, the `onEvent` callback from EventBridge pushes events to EventBuffer and broadcasts to SSE clients.

### Files

- Modify: `src/server/actor-server.ts`
- Modify: `src/server/actor-server.test.ts`

### Key reusable modules

- `src/server/event-buffer.ts` — `EventBuffer` class (numeric IDs, circular buffer, `getEventsSince`)
- `src/server/sse-handler.ts` — `handleSseStream`, `broadcastSseEvent`, `SseClient` type

---

- [ ] **Step 1: Write failing test for `GET /events` SSE with dashboard-compatible snapshot**

Add to `src/server/actor-server.test.ts`:

```ts
import { EventSource } from 'eventsource'; // or undici, depending on test setup

describe('SSE /events (dashboard)', () => {
  it('sends snapshot with tree structure on connect', async () => {
    const events: Array<{ type: string; data: any }> = [];

    await new Promise<void>((resolve) => {
      const es = new EventSource(`http://localhost:${port}/events`);
      es.addEventListener('snapshot', (e: MessageEvent) => {
        events.push({ type: 'snapshot', data: JSON.parse(e.data) });
        es.close();
        resolve();
      });
    });

    expect(events).toHaveLength(1);
    const snapshot = events[0].data;
    expect(snapshot).toHaveProperty('tree');
    expect(snapshot.tree).toHaveProperty('id');
    expect(snapshot.tree).toHaveProperty('name');
    expect(snapshot.tree).toHaveProperty('type');
    expect(snapshot.tree).toHaveProperty('children');
    expect(snapshot).toHaveProperty('blackboard');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/actor-server.test.ts -t "sends snapshot with tree structure"`
Expected: FAIL — `/events` route doesn't exist or returns wrong snapshot shape

- [ ] **Step 3: Add EventBuffer, SSE clients set, and `/events` route**

Edit `src/server/actor-server.ts`:

1. Add imports:
```ts
import { EventBuffer } from './event-buffer.js';
import { broadcastSseEvent } from './sse-handler.js';
import type { SseClient } from './sse-handler.js';
import { serializeTree as serializeTreeForApi } from './serializers.js';
```

Note: We do NOT reuse `handleSseStream` because it reads the blackboard from a live tree instance. ActorServer's blackboard lives in the StateStore, so we need a custom SSE handler that reads from StateStore instead.

2. Add properties to the class:
```ts
private readonly eventBuffer: EventBuffer = new EventBuffer(500);
private readonly sseClients: Set<SseClient> = new Set();
```

3. Add `/events` route in `handleRequest` (before the existing `/api/events` handler):
```ts
if (method === 'GET' && url.pathname === '/events') {
  return this.handleDashboardSSE(req, res);
}
```

4. Implement `handleDashboardSSE` — creates tree from factory for structure, reads blackboard from StateStore:
```ts
private async handleDashboardSSE(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Build snapshot from factory tree (structure) + state store (blackboard)
  const tree = this.createTree();
  const state = await this.stateStore.getState('default');
  const snapshot = {
    tree: serializeTreeForApi(tree.root),
    blackboard: state?.blackboard ?? {},
  };

  // Send snapshot
  const snapshotId = this.eventBuffer.latestId;
  res.write(`id: ${snapshotId}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

  // Replay missed events on reconnect
  const lastEventId = req.headers['last-event-id'];
  if (lastEventId) {
    const lastId = parseInt(lastEventId as string, 10);
    if (!isNaN(lastId)) {
      const missed = this.eventBuffer.getEventsSince(lastId);
      if (missed === null) {
        // Buffer gap — resend snapshot (already sent above)
      } else {
        for (const event of missed) {
          res.write(`id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
        }
      }
    }
  }

  this.sseClients.add(res);
  req.on('close', () => {
    this.sseClients.delete(res);
  });
}
```

- [ ] **Step 4: Run test to verify snapshot shape passes**

Run: `npx vitest run src/server/actor-server.test.ts -t "sends snapshot with tree structure"`
Expected: PASS

- [ ] **Step 5: Write failing test for real-time event broadcasting**

```ts
it('broadcasts tree events in real-time during message processing', async () => {
  const received: Array<{ type: string; data: any; id: number }> = [];

  // Connect SSE first
  const es = new EventSource(`http://localhost:${port}/events`);
  await new Promise<void>((resolve) => {
    es.addEventListener('snapshot', () => resolve());
  });

  // Listen for node events
  for (const eventName of ['node:enter', 'node:exit', 'tree:tick', 'message:processed']) {
    es.addEventListener(eventName, (e: MessageEvent) => {
      const id = parseInt((e as any).lastEventId, 10);
      received.push({ type: eventName, data: JSON.parse(e.data), id });
    });
  }

  // Send a message to trigger tree processing
  await fetch(`http://localhost:${port}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'tick' }),
  });

  // Wait for message:processed
  await vi.waitFor(() => {
    expect(received.some(e => e.type === 'message:processed')).toBe(true);
  }, { timeout: 5000 });

  // Should have received real-time events
  expect(received.some(e => e.type === 'node:enter')).toBe(true);
  expect(received.some(e => e.type === 'tree:tick')).toBe(true);

  // IDs should be numeric and monotonically increasing
  const ids = received.map(e => e.id);
  expect(ids.every(id => typeof id === 'number' && !isNaN(id))).toBe(true);
  for (let i = 1; i < ids.length; i++) {
    expect(ids[i]).toBeGreaterThan(ids[i - 1]);
  }

  es.close();
});
```

- [ ] **Step 6: Run test to verify it fails**

Expected: FAIL — no events broadcasted to SSE clients during processing

- [ ] **Step 7: Wire onEvent callback in processAsync to broadcast events**

Edit `processAsync` in `src/server/actor-server.ts`:

1. Pass an `onEvent` callback to EventBridge that pushes to EventBuffer and broadcasts:
```ts
const bridge = new EventBridge(this.stateStore, 'default', clientMessageId, (event) => {
  this.trackEvent(event);
  const entry = this.eventBuffer.push(event.type, event.data);
  broadcastSseEvent(this.sseClients, entry);
});
```

This replaces the current `new EventBridge(this.stateStore, 'default', clientMessageId)` call.

- [ ] **Step 8: Run test to verify real-time broadcasting passes**

Run: `npx vitest run src/server/actor-server.test.ts -t "broadcasts tree events"`
Expected: PASS

- [ ] **Step 9: Close SSE clients on server stop**

Update `stop()` method:
```ts
async stop(): Promise<void> {
  // Close SSE clients
  for (const client of this.sseClients) {
    client.end();
  }
  this.sseClients.clear();

  return new Promise((resolve) => {
    if (!this.server) return resolve();
    this.server.close(() => resolve());
  });
}
```

- [ ] **Step 10: Run full test suite**

Run: `npx vitest run src/server/actor-server.test.ts`
Expected: All tests pass

- [ ] **Step 11: Commit**

```bash
git add src/server/actor-server.ts src/server/actor-server.test.ts
git commit -m "feat(actor-server): real-time SSE broadcasting at /events with EventBuffer and numeric IDs"
```
