# Task 108: Integration Test — Serve Command + Dashboard SSE End-to-End

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integration test verifying that ActorServer + DashboardServer work together — SSE events stream through the proxy, dashboard-compatible response shapes are correct, and lifecycle events propagate.

**Depends on:** Tasks 105, 106, 107

---

### Context

This test exercises the full stack: ActorServer serves dashboard-compatible endpoints, DashboardServer proxies them, and the SSE event pipeline works end-to-end (send message → tree processes → events stream to SSE client via proxy).

### Files

- Create: `src/__integration__/actor-dashboard.test.ts`

---

- [ ] **Step 1: Write integration test**

Create `src/__integration__/actor-dashboard.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ActorServer } from '../server/actor-server.js';
import { TreeBuilder } from '../builder/tree-builder.js';
import { NodeStatus } from '../types.js';

// Import DashboardServer from the compiled output
// (dashboard server is compiled to dist/dashboard-server/)
// For integration tests, we test ActorServer directly without DashboardServer proxy

function makeTree() {
  return new TreeBuilder('integration-test')
    .sequence('main')
      .action('step-1', async (ctx) => {
        ctx.blackboard.set('result', 'done');
        return NodeStatus.SUCCESS;
      })
    .end()
    .build();
}

describe('ActorServer dashboard integration', () => {
  let server: ActorServer;
  let port: number;

  beforeAll(async () => {
    server = new ActorServer({
      createTree: makeTree,
      port: 0,
    });
    ({ port } = await server.start());
  });

  afterAll(async () => {
    await server.stop();
  });

  it('GET /api/tree returns dashboard-compatible tree structure', async () => {
    const res = await fetch(`http://localhost:${port}/api/tree`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.tree).toBe('integration-test');
    expect(body.root).toMatchObject({
      id: expect.any(String),
      name: 'main',
      type: 'sequence',
      children: expect.arrayContaining([
        expect.objectContaining({ name: 'step-1', type: 'action' }),
      ]),
    });
  });

  it('GET /api/status returns tick stats shape', async () => {
    const res = await fetch(`http://localhost:${port}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      tree: 'integration-test',
      tickCount: expect.any(Number),
      cycleCount: expect.any(Number),
      lastStatus: expect.toBeOneOf([null, expect.any(String)]),
      lastDurationMs: expect.toBeOneOf([null, expect.any(Number)]),
      uptime: expect.any(Number),
    });
  });

  it('GET /api/nodes/:id returns node detail', async () => {
    const treeRes = await fetch(`http://localhost:${port}/api/tree`);
    const { root } = await treeRes.json();

    const res = await fetch(`http://localhost:${port}/api/nodes/${root.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(root.id);
    expect(body.name).toBe('main');
  });

  it('SSE /events streams real-time events during message processing', async () => {
    const received: Array<{ type: string; data: any }> = [];

    // Connect to SSE
    const controller = new AbortController();
    const sseRes = await fetch(`http://localhost:${port}/events`, {
      headers: { 'Accept': 'text/event-stream' },
      signal: controller.signal,
    });

    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Read snapshot
    const readUntil = async (eventType: string) => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop()!;
        for (const block of lines) {
          const eventMatch = block.match(/event: (.+)/);
          const dataMatch = block.match(/data: (.+)/);
          if (eventMatch && dataMatch) {
            received.push({
              type: eventMatch[1],
              data: JSON.parse(dataMatch[1]),
            });
            if (eventMatch[1] === eventType) return;
          }
        }
      }
    };

    await readUntil('snapshot');

    // Verify snapshot has tree structure
    const snapshot = received.find(e => e.type === 'snapshot');
    expect(snapshot).toBeDefined();
    expect(snapshot!.data.tree).toHaveProperty('children');
    expect(snapshot!.data).toHaveProperty('blackboard');

    // Send a tick message
    await fetch(`http://localhost:${port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tick' }),
    });

    // Read until message:processed
    await readUntil('message:processed');
    controller.abort();

    // Verify we received tree events
    const types = received.map(e => e.type);
    expect(types).toContain('node:enter');
    expect(types).toContain('node:exit');
    expect(types).toContain('tree:tick');
    expect(types).toContain('message:processed');

    // Verify tick stats updated
    const statusRes = await fetch(`http://localhost:${port}/api/status`);
    const status = await statusRes.json();
    expect(status.tickCount).toBeGreaterThan(0);
  });

  it('GET /api/blackboard reflects state after processing', async () => {
    // Already processed a tick message in previous test
    const res = await fetch(`http://localhost:${port}/api/blackboard`);
    const body = await res.json();
    expect(body.result).toBe('done');
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npx vitest run src/__integration__/actor-dashboard.test.ts`
Expected: All tests pass

- [ ] **Step 3: Run full test suite for regressions**

Run: `npm run test:all`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/__integration__/actor-dashboard.test.ts
git commit -m "test: integration test for ActorServer dashboard-compatible endpoints and SSE"
```
