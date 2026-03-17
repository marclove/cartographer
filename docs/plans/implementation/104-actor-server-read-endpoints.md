# Task 104: Update ActorServer Read Endpoints for Dashboard Compatibility

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update ActorServer's `GET /api/tree` and `GET /api/status` to return dashboard-compatible response shapes, and add `GET /api/nodes/:id`.

**Depends on:** Task 103 (export findNodeById)

---

### Context

The dashboard expects specific response shapes from its backend:

| Endpoint | Dashboard expects | ActorServer currently returns |
|---|---|---|
| `GET /api/tree` | `{ tree: string, root: SerializedTreeNode }` | `{ name: string, rootHash: string }` |
| `GET /api/status` | `{ tree, tickCount, cycleCount, lastStatus, lastDurationMs, uptime }` | `{ lastMessageAt, treeRootHash }` |
| `GET /api/nodes/:id` | `{ id, name, type, model?, tools?, children? }` | (doesn't exist) |

ActorServer has a `createTree` factory — it can create a tree instance for serialization. Since the tree structure is static (same factory), this works for read-only introspection.

For tick stats, we need to track them in memory on ActorServer, updating them during message processing.

### Files

- Modify: `src/server/actor-server.ts`
- Modify: `src/server/actor-server.test.ts`

---

- [ ] **Step 1: Write failing test for `GET /api/tree` new shape**

Add to `src/server/actor-server.test.ts`:

```ts
it('GET /api/tree returns full tree structure', async () => {
  const res = await fetch(`http://localhost:${port}/api/tree`);
  const body = await res.json();
  expect(body).toHaveProperty('tree'); // tree name string
  expect(body).toHaveProperty('root');
  expect(body.root).toHaveProperty('id');
  expect(body.root).toHaveProperty('name');
  expect(body.root).toHaveProperty('type');
  expect(body.root).toHaveProperty('children');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/actor-server.test.ts -t "GET /api/tree returns full tree structure"`
Expected: FAIL — `root` property missing (currently returns `{ name, rootHash }`)

- [ ] **Step 3: Update `GET /api/tree` handler**

Edit `src/server/actor-server.ts`:

1. Add import for the dashboard serializer (note: different from core/serialization.js):
```ts
import { serializeTree as serializeTreeForApi, serializeNodeRef } from './serializers.js';
import { findNodeById } from './api-handlers.js';
```

2. Update the `/api/tree` handler (around line 116):
```ts
if (method === 'GET' && url.pathname === '/api/tree') {
  const tree = this.createTree();
  return jsonResponse(res, 200, { tree: tree.name, root: serializeTreeForApi(tree.root) });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/actor-server.test.ts -t "GET /api/tree returns full tree structure"`
Expected: PASS

- [ ] **Step 5: Write failing test for `GET /api/status` new shape**

```ts
it('GET /api/status returns tick stats', async () => {
  const res = await fetch(`http://localhost:${port}/api/status`);
  const body = await res.json();
  expect(body).toHaveProperty('tree');
  expect(body).toHaveProperty('tickCount');
  expect(body).toHaveProperty('cycleCount');
  expect(body).toHaveProperty('lastStatus');
  expect(body).toHaveProperty('lastDurationMs');
  expect(body).toHaveProperty('uptime');
  expect(body.tickCount).toBe(0); // no messages processed yet
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/server/actor-server.test.ts -t "GET /api/status returns tick stats"`
Expected: FAIL — missing tickCount, cycleCount, etc.

- [ ] **Step 7: Add StatusState tracking and update `GET /api/status`**

Edit `src/server/actor-server.ts`:

1. Import StatusState type (or define inline):
```ts
interface ActorStatusState {
  tickCount: number;
  cycleCount: number;
  lastStatus: string | null;
  lastDurationMs: number | null;
}
```

2. Add to class properties:
```ts
private readonly stats: ActorStatusState = {
  tickCount: 0,
  cycleCount: 0,
  lastStatus: null,
  lastDurationMs: null,
};
```

3. Update the `/api/status` handler:
```ts
if (method === 'GET' && url.pathname === '/api/status') {
  const tree = this.createTree();
  return jsonResponse(res, 200, {
    tree: tree.name,
    tickCount: this.stats.tickCount,
    cycleCount: this.stats.cycleCount,
    lastStatus: this.stats.lastStatus,
    lastDurationMs: this.stats.lastDurationMs,
    uptime: Date.now() - this.startTime,
  });
}
```

4. Update stats during `processAsync` — add a method to track tick events:
```ts
private trackEvent(event: { type: string; data: Record<string, unknown> }): void {
  if (event.type === 'tree:tick') {
    this.stats.tickCount++;
    this.stats.lastStatus = event.data.status as string;
    this.stats.lastDurationMs = event.data.durationMs as number;
    if (event.data.status !== 'running') {
      this.stats.cycleCount++;
    }
  }
}
```

This will be called from the `onEvent` callback in Task 105. For now, just add the method and the stats object.

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/server/actor-server.test.ts -t "GET /api/status returns tick stats"`
Expected: PASS

- [ ] **Step 9: Write failing test for `GET /api/nodes/:id`**

```ts
it('GET /api/nodes/:id returns node detail', async () => {
  // First get the tree to find a node ID
  const treeRes = await fetch(`http://localhost:${port}/api/tree`);
  const tree = await treeRes.json();
  const nodeId = tree.root.id;

  const res = await fetch(`http://localhost:${port}/api/nodes/${encodeURIComponent(nodeId)}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty('id', nodeId);
  expect(body).toHaveProperty('name');
  expect(body).toHaveProperty('type');
});

it('GET /api/nodes/nonexistent returns 404', async () => {
  const res = await fetch(`http://localhost:${port}/api/nodes/nonexistent`);
  expect(res.status).toBe(404);
});
```

- [ ] **Step 10: Run tests to verify they fail**

Run: `npx vitest run src/server/actor-server.test.ts -t "GET /api/nodes"`
Expected: FAIL — route doesn't exist (404)

- [ ] **Step 11: Add `GET /api/nodes/:id` handler**

Edit `src/server/actor-server.ts`, add after the `/api/tree` handler:

```ts
const nodeMatch = url.pathname.match(/^\/api\/nodes\/(.+)$/);
if (method === 'GET' && nodeMatch) {
  const tree = this.createTree();
  const nodeId = decodeURIComponent(nodeMatch[1]);
  const node = findNodeById(tree.root, nodeId);
  if (!node) {
    return jsonError(res, 404, 'Not found');
  }
  const detail: Record<string, unknown> = { ...serializeNodeRef(node) };
  if (node instanceof AgentNode) {
    const config = (node as any).config;
    if (config) {
      const opts = config.options ?? {};
      if (opts.model) detail.model = opts.model;
      detail.tools = opts.allowedTools ?? [];
      const mcpServers = opts.mcpServers ? Object.keys(opts.mcpServers) : [];
      detail.mcpServers = mcpServers;
    }
  }
  if (node.children.length > 0) {
    detail.children = node.children.map(serializeNodeRef);
  }
  return jsonResponse(res, 200, detail);
}
```

Add import for AgentNode:
```ts
import { AgentNode } from '../nodes/agent.js';
```

- [ ] **Step 12: Run tests to verify they pass**

Run: `npx vitest run src/server/actor-server.test.ts -t "GET /api/nodes"`
Expected: PASS

- [ ] **Step 13: Update any existing tests broken by response shape changes**

The existing tests for `GET /api/tree` and `GET /api/status` may assert the old shapes. Update them to match the new shapes.

Run: `npx vitest run src/server/actor-server.test.ts`
Expected: All tests pass

- [ ] **Step 14: Commit**

```bash
git add src/server/actor-server.ts src/server/actor-server.test.ts
git commit -m "feat(actor-server): dashboard-compatible read endpoints (tree structure, tick stats, node detail)"
```
