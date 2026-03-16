# Task 96: ActorServer — Write Endpoints + Async Processing

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add write endpoints (POST /api/messages, /api/actions/:name, /api/blackboard/:key) with async 202 processing model, locking, and heartbeat.

**Depends on:** Task 095 (ActorServer read endpoints), Task 094 (TreeActor)

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Sections 1 (Async Processing Model, Locking), 4 (Write Endpoints, Error Responses)

---

### Context

Write endpoints return 202 immediately. Processing runs as an in-process background task:
1. Acquire lock (409 if held)
2. Return `{ id, status: "processing" }`
3. Background: load state → TreeActor.process(msg) → save state
4. Emit `message:processed` or `message:failed` event
5. Release lock

Lock heartbeat renews every 10s for long-running agent calls.

### Step 1: Add write endpoint routing to ActorServer

Edit `src/server/actor-server.ts` — add to `handleRequest()`:

```ts
// POST /api/messages
if (method === 'POST' && url.pathname === '/api/messages') {
  return this.handleMessage(req, res);
}

// POST /api/actions/:name
const actionMatch = url.pathname.match(/^\/api\/actions\/(.+)$/);
if (method === 'POST' && actionMatch) {
  return this.handleAction(req, res, actionMatch[1]);
}

// POST /api/blackboard/:key
const bbMatch = url.pathname.match(/^\/api\/blackboard\/(.+)$/);
if (method === 'POST' && bbMatch) {
  return this.handleBlackboardWrite(req, res, bbMatch[1]);
}
```

### Step 2: Implement handleMessage

```ts
private async handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await this.readBody(req);
  if (!body || !body.type) {
    return this.jsonResponse(res, 400, { error: 'Missing message type' });
  }
  if (body.type === 'action' && !body.name) {
    return this.jsonResponse(res, 400, { error: 'Action message requires name' });
  }

  const messageId = body.id ?? generateMessageId();
  const msg: ActorMessage = { ...body, id: messageId };

  await this.processAsync(msg, messageId, res);
}
```

### Step 3: Implement processAsync (lock + background task)

```ts
private async processAsync(msg: ActorMessage, messageId: string, res: ServerResponse): Promise<void> {
  const requestId = generateMessageId(); // unique ID for the lock

  // Acquire lock
  const acquired = await this.stateStore.acquireLock('default', requestId, 30000);
  if (!acquired) {
    return this.jsonResponse(res, 409, { error: 'Processing in progress' });
  }

  // Return 202 immediately
  this.jsonResponse(res, 202, { id: messageId, status: 'processing' });

  // Start heartbeat
  const heartbeat = setInterval(async () => {
    await this.stateStore.acquireLock('default', requestId, 30000);
    // Note: this uses XX semantics in Redis — InMemoryStateStore can ignore ttl renewal
  }, 10000);

  // Process in background
  try {
    const actor = new TreeActor({
      createTree: this.createTree,
      stateStore: this.stateStore,
      stateKey: 'default',
      topologyPolicy: this.topologyPolicy,
    });
    const result = await actor.process(msg);

    await this.stateStore.appendEvents('default', [{
      id: generateMessageId(),
      type: 'message:processed',
      data: { messageId, treeStatus: String(result.treeStatus) },
      timestamp: Date.now(),
    }]);
  } catch (error) {
    await this.stateStore.appendEvents('default', [{
      id: generateMessageId(),
      type: 'message:failed',
      data: { messageId, error: error instanceof Error ? error.message : String(error) },
      timestamp: Date.now(),
    }]);
  } finally {
    clearInterval(heartbeat);
    await this.stateStore.releaseLock('default', requestId);
  }
}
```

### Step 4: Implement convenience endpoints

```ts
private async handleAction(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
  const payload = await this.readBody(req);
  const messageId = generateMessageId();
  await this.processAsync({ type: 'action', name, payload, id: messageId }, messageId, res);
}

private async handleBlackboardWrite(req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
  const body = await this.readBody(req);
  const value = body?.value;
  const messageId = generateMessageId();
  await this.processAsync({ type: 'write', key, value, id: messageId }, messageId, res);
}

private readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve(null); }
    });
  });
}
```

### Step 5: Write tests

Add to `src/server/actor-server.test.ts`:

```ts
describe('write endpoints', () => {
  it('POST /api/messages returns 202 with message ID', async () => {
    // start server, POST a message, verify 202 + id + processing status
  });

  it('POST /api/messages returns 409 when lock is held', async () => {
    // acquire lock manually, then POST — should get 409
  });

  it('POST /api/messages returns 400 for invalid message', async () => {
    // POST with missing type field
  });

  it('POST /api/actions/:name is convenience for action messages', async () => {
    // POST to /api/actions/approve with payload, verify state changes
  });

  it('POST /api/blackboard/:key writes value', async () => {
    // POST to /api/blackboard/foo with { value: 'bar' }, verify blackboard
  });

  it('emits message:processed event on successful processing', async () => {
    // POST a message, read events from store, verify message:processed
  });

  it('emits message:failed event on processing error', async () => {
    // Use a tree factory that throws, verify message:failed event
  });
});
```

### Step 6: Run tests

Run: `npx vitest run src/server/actor-server.test.ts`

### Step 7: Typecheck + full suite

Run: `npm run typecheck && npm run test`

### Step 8: Commit

```bash
git add src/server/actor-server.ts src/server/actor-server.test.ts
git commit -m "feat(server): add write endpoints with async 202 processing, locking, and heartbeat"
```
