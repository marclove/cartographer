# Task 97: SSE Event Delivery via StateStore

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the `GET /api/events` SSE endpoint that reads from the StateStore's event stream, sends a snapshot on connect, and streams incremental events.

**Depends on:** Tasks 093 (StateStore), 095 (ActorServer read endpoints)

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 3 (SSE Event Delivery)

---

### Context

SSE on connect:
1. Send a full state snapshot (blackboard, tree status, pending client events, `processingMessageId`)
2. Stream incremental events via `stateStore.readEvents()`

The existing `EventBuffer` from `src/server/event-buffer.ts` handles circular buffering. The existing `handleSseStream` from `src/server/sse-handler.ts` handles SSE wire format. Reuse both where possible.

The `readEvents()` AsyncIterable must handle client disconnection gracefully — break out of the loop and clean up when the HTTP response closes. See memory note on async iterable teardown.

### Step 1: Add SSE endpoint to ActorServer

Edit `src/server/actor-server.ts`:

```ts
if (method === 'GET' && url.pathname === '/api/events') {
  return this.handleSSE(req, res);
}
```

### Step 2: Implement handleSSE

```ts
private async handleSSE(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send snapshot on connect
  const state = await this.stateStore.getState('default');
  const snapshot = {
    blackboard: state?.blackboard ?? {},
    treeRootHash: state?.treeState.rootHash ?? null,
    lastMessageAt: state?.lastMessageAt ?? null,
    processingMessageId: null, // TODO: track in-progress message
  };
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

  // Handle Last-Event-ID for reconnection
  const lastEventId = req.headers['last-event-id'] as string | undefined;

  // Stream events
  let closed = false;
  req.on('close', () => { closed = true; });

  try {
    for await (const event of this.stateStore.readEvents('default', lastEventId)) {
      if (closed) break;
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    }
  } catch (error) {
    // Connection closed or error — clean exit
  } finally {
    if (!closed) res.end();
  }
}
```

### Step 3: Wire events from TreeActor processing

During `processAsync()` (Task 96), tree events need to be forwarded to the StateStore's event stream. The TreeActor should accept an `onEvent` callback, or events emitted via `tree.events` should be captured and appended.

Add to the background processing in `processAsync()`:

```ts
// Subscribe to tree events and forward to StateStore
tree.events.onAny((eventType, data) => {
  this.stateStore.appendEvents('default', [{
    id: generateMessageId(),
    type: eventType,
    data,
    timestamp: Date.now(),
  }]);
});
```

This requires the TreeActor to expose the tree's events, or the ActorServer to subscribe before calling `process()`. Design the integration based on how TreeActor and BehaviorTree expose events.

### Step 4: Write tests

Add to `src/server/actor-server.test.ts`:

```ts
describe('SSE events', () => {
  it('GET /api/events returns SSE stream with snapshot', async () => {
    // Start server, connect to SSE, verify snapshot event
  });

  it('receives events during processing', async () => {
    // Connect SSE, POST a message, verify events arrive
  });

  it('supports Last-Event-ID reconnection', async () => {
    // Append events, connect with Last-Event-ID, verify replay
  });

  it('handles client disconnection gracefully', async () => {
    // Connect SSE, close connection, verify no resource leak
  });
});
```

### Step 5: Run tests

Run: `npx vitest run src/server/actor-server.test.ts`

### Step 6: Commit

```bash
git add src/server/actor-server.ts
git commit -m "feat(server): add SSE event delivery endpoint with snapshot and Last-Event-ID replay"
```
