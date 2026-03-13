# Task 48: REST API Endpoint Tests

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add thorough tests for the REST API endpoints (`/api/tree`, `/api/status`, `/api/blackboard`, `/api/nodes/:id`). The stub implementations in Task 47 are promoted to production code here, with test coverage and any gaps filled.

**Depends on:** Task 47

---

### Step 1: Write REST endpoint tests

Create `src/server/__integration__/rest-api.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DashboardServer } from '../dashboard-server.js';
import { BehaviorTree } from '../../core/behavior-tree.js';
import { InMemoryBlackboard } from '../../core/blackboard.js';
import { ActionNode } from '../../nodes/action.js';
import { ConditionNode } from '../../nodes/condition.js';
import { SequenceNode } from '../../composites/sequence.js';
import { NodeStatus } from '../../types.js';

let server: DashboardServer;
let port: number;
let tree: BehaviorTree;

function createTree() {
  const check = new ConditionNode({ name: 'CheckReady', id: 'check-ready', condition: async () => true });
  const act = new ActionNode({ name: 'DoWork', id: 'do-work', action: async () => NodeStatus.SUCCESS });
  const root = new SequenceNode({ name: 'Main', id: 'main', children: [check, act] });
  const bb = new InMemoryBlackboard({ env: 'test', 'scoped:key': 42 });
  return new BehaviorTree({ name: 'IntegrationTree', root, blackboard: bb });
}

beforeAll(async () => {
  tree = createTree();
  server = new DashboardServer(tree, { port: 0 });
  ({ port } = await server.start());
});

afterAll(async () => {
  await server.close();
});

describe('GET /api/tree', () => {
  it('returns full tree structure with hierarchy', async () => {
    const res = await fetch(`http://localhost:${port}/api/tree`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tree).toBe('IntegrationTree');
    expect(body.root.id).toBe('main');
    expect(body.root.type).toBe('sequence');
    expect(body.root.children).toHaveLength(2);
    expect(body.root.children[0].id).toBe('check-ready');
    expect(body.root.children[0].type).toBe('condition');
    expect(body.root.children[1].id).toBe('do-work');
    expect(body.root.children[1].type).toBe('action');
  });
});

describe('GET /api/status', () => {
  it('returns run status before any ticks', async () => {
    const res = await fetch(`http://localhost:${port}/api/status`);
    const body = await res.json();
    expect(body.tree).toBe('IntegrationTree');
    expect(body.tickCount).toBe(0);
    expect(body.lastStatus).toBeNull();
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('reflects status after a tick', async () => {
    await tree.tick();
    const res = await fetch(`http://localhost:${port}/api/status`);
    const body = await res.json();
    expect(body.tickCount).toBe(1);
    expect(body.lastStatus).toBe('success');
    expect(body.lastDurationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /api/blackboard', () => {
  it('returns full blackboard snapshot with scoped keys', async () => {
    const res = await fetch(`http://localhost:${port}/api/blackboard`);
    const body = await res.json();
    expect(body.env).toBe('test');
    expect(body['scoped:key']).toBe(42);
  });
});

describe('GET /api/nodes/:id', () => {
  it('returns node detail for a valid ID', async () => {
    const res = await fetch(`http://localhost:${port}/api/nodes/check-ready`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('check-ready');
    expect(body.name).toBe('CheckReady');
    expect(body.type).toBe('condition');
  });

  it('returns 404 for unknown node ID', async () => {
    const res = await fetch(`http://localhost:${port}/api/nodes/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not found', status: 404 });
  });
});
```

### Step 2: Run tests to verify they pass

Run: `npx vitest run src/server/__integration__/rest-api.test.ts`
Expected: All pass (implementations were stubbed in Task 47).

If any fail, adjust the handlers in `src/server/api-handlers.ts` to match. The API contract is defined in the spec: `docs/superpowers/specs/2026-03-12-web-dashboard-design.md`.

### Step 3: Typecheck

Run: `npm run typecheck`
Expected: All pass.

### Step 4: Commit

```bash
git add src/server/__integration__/rest-api.test.ts src/server/api-handlers.ts
git commit -m "test(server): add REST API endpoint integration tests"
```
