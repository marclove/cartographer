# Task 100: Integration Tests — Full Processing Loop

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** End-to-end integration tests that verify the full processing pipeline: client → ActorServer → TreeActor → tree execution → serialization → SSE events.

**Depends on:** All previous tasks (080–099)

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 7 (Example: Full Application)

---

### Context

These tests exercise the complete flow described in the spec's example application: a tree with agent nodes, `emitToClient`, `actionReceived`, `untilSuccess`, and the full serialize/restore cycle across multiple messages.

### Step 1: Create integration test file

Create `src/__integration__/actor-framework.test.ts`:

```ts
describe('Actor Framework Integration', () => {
  let server: ActorServer;
  let port: number;
  let store: InMemoryStateStore;

  beforeEach(async () => {
    store = new InMemoryStateStore();
    server = new ActorServer({
      createTree: () => new BehaviorTree({
        name: 'review-flow',
        root: sequence([
          // Simulated agent: writes a result to blackboard
          new ActionNode({
            name: 'analyze',
            action: async (ctx) => {
              ctx.blackboard.set('analyze:result', { summary: 'Looks good' });
              return NodeStatus.SUCCESS;
            },
          }),
          emitToClient('ui:show_review', (ctx) => ({
            findings: ctx.blackboard.get('analyze:result'),
          })),
          untilSuccess(
            selector([
              sequence([actionReceived('approve'), new ActionNode({
                name: 'finalize',
                action: async (ctx) => {
                  ctx.blackboard.set('outcome', 'approved');
                  return NodeStatus.SUCCESS;
                },
              })]),
              sequence([actionReceived('reject'), new ActionNode({
                name: 'archive',
                action: async (ctx) => {
                  ctx.blackboard.set('outcome', 'rejected');
                  return NodeStatus.SUCCESS;
                },
              })]),
            ])
          ),
        ]),
      }),
      stateStore: store,
      port: 0,
    });
    await server.start();
    port = /* get actual port */;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('full review flow: tick → emit → action → complete', async () => {
    // 1. Send initial tick to start the tree
    const tickRes = await fetch(`http://localhost:${port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tick' }),
    });
    expect(tickRes.status).toBe(202);

    // Wait for processing to complete
    await waitForProcessed(port);

    // 2. Verify emitToClient wrote to blackboard
    const bb1 = await (await fetch(`http://localhost:${port}/api/blackboard`)).json();
    expect(bb1['clientEvents:ui:show_review']).toBeDefined();
    expect(bb1['analyze:result']).toEqual({ summary: 'Looks good' });

    // 3. Tree should be suspended at untilSuccess (RUNNING)
    // Verify via events in the store
    const events = [];
    const iter = store.readEvents('default')[Symbol.asyncIterator]();
    // Collect available events
    // ...

    // 4. Send approve action
    const approveRes = await fetch(`http://localhost:${port}/api/actions/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(approveRes.status).toBe(202);

    await waitForProcessed(port);

    // 5. Verify outcome
    const bb2 = await (await fetch(`http://localhost:${port}/api/blackboard`)).json();
    expect(bb2['outcome']).toBe('approved');
  });

  it('state survives across ActorServer restarts', async () => {
    // 1. Process initial tick
    await fetch(`http://localhost:${port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tick' }),
    });
    await waitForProcessed(port);

    // 2. Stop server
    await server.stop();

    // 3. Restart with same store (simulating process restart)
    server = new ActorServer({
      createTree: () => /* same factory */,
      stateStore: store,
      port: 0,
    });
    await server.start();
    port = /* new port */;

    // 4. State should be preserved — tree is suspended at untilSuccess
    const bb = await (await fetch(`http://localhost:${port}/api/blackboard`)).json();
    expect(bb['analyze:result']).toEqual({ summary: 'Looks good' });

    // 5. Continue the flow with an action
    await fetch(`http://localhost:${port}/api/actions/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    await waitForProcessed(port);

    const bb2 = await (await fetch(`http://localhost:${port}/api/blackboard`)).json();
    expect(bb2['outcome']).toBe('rejected');
  });

  it('409 when two messages are sent concurrently', async () => {
    // Send two messages in quick succession
    const [res1, res2] = await Promise.all([
      fetch(`http://localhost:${port}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'tick' }),
      }),
      fetch(`http://localhost:${port}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'tick' }),
      }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([202, 409]);
  });

  it('topology mismatch is reported via message:failed', async () => {
    // Save state with one tree, try to process with a different tree
    // Verify message:failed event
  });
});

/** Helper: wait for processing to complete by polling events. */
async function waitForProcessed(port: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Poll blackboard or status to detect completion
    await new Promise(r => setTimeout(r, 50));
    // Check if lock is released (no longer processing)
    // This is a rough heuristic — could also check events
  }
}
```

### Step 2: Run integration tests

Run: `npx vitest run --project integration src/__integration__/actor-framework.test.ts`
Expected: All pass.

### Step 3: Commit

```bash
git add src/__integration__/actor-framework.test.ts
git commit -m "test(integration): add end-to-end actor framework tests covering full processing pipeline"
```
