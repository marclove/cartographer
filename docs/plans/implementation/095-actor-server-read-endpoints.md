# Task 95: ActorServer — Config, Health, Read Endpoints

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the ActorServer with configuration, platform health endpoint, and read endpoints. Reuses existing handlers from TreeServer where possible.

**Depends on:** Task 094 (TreeActor), Task 093 (StateStore)

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 4 (ActorServer Phase 1)

---

### Context

The ActorServer replaces TreeServer as the HTTP layer. It reuses existing read-endpoint handlers (`handleApiTree`, `handleApiStatus`, `handleApiBlackboard`, `handleApiNode` from `src/server/api-handlers.ts`), SSE handler, and event serializers. The key difference: state is loaded from the StateStore rather than from a live in-memory tree.

### Step 1: Create ActorServer

Create `src/server/actor-server.ts`:

```ts
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BehaviorTree } from '../core/behavior-tree.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';
import type { StateStore } from '../state/state-store.js';
import { serializeTree } from '../core/serialization.js';

export interface ActorServerOptions {
  createTree: () => BehaviorTree;
  stateStore?: StateStore;
  port?: number;
  context?: Record<string, unknown>;
  topologyPolicy?: 'fail' | 'reset';
}

export class ActorServer {
  private createTree: () => BehaviorTree;
  private stateStore: StateStore;
  private port: number;
  private context: Record<string, unknown>;
  private topologyPolicy: 'fail' | 'reset';
  private server: ReturnType<typeof createServer> | null = null;
  private startTime = 0;

  constructor(options: ActorServerOptions) {
    this.createTree = options.createTree;
    this.stateStore = options.stateStore ?? new InMemoryStateStore();
    this.port = options.port ?? parseInt(process.env.PORT ?? '3148', 10);
    this.context = options.context ?? {};
    this.topologyPolicy = options.topologyPolicy ?? 'fail';
  }

  async start(): Promise<void> {
    this.startTime = Date.now();

    // Initialize default state if not present
    const existing = await this.stateStore.getState('default');
    if (!existing) {
      await this.initializeDefaultState();
    }

    this.server = createServer((req, res) => this.handleRequest(req, res));

    // Graceful shutdown
    const shutdown = async () => {
      // TODO: wait for in-progress processing
      this.server?.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    return new Promise((resolve) => {
      this.server!.listen(this.port, () => resolve());
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.close(() => resolve());
    });
  }

  private async initializeDefaultState(): Promise<void> {
    const tree = this.createTree();
    // Write context to blackboard
    for (const [key, value] of Object.entries(this.context)) {
      tree.blackboard.set(`context:${key}`, value);
    }
    const blackboard = this.serializeBlackboard(tree.blackboard);
    const treeState = serializeTree(tree.root, tree.rootHash);
    await this.stateStore.saveState('default', {
      blackboard,
      treeState,
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = req.method ?? 'GET';

    // Platform health
    if (method === 'GET' && url.pathname === '/_platform/health') {
      return this.jsonResponse(res, 200, {
        status: 'ok',
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
      });
    }

    // Read endpoints — load state from store
    if (method === 'GET' && url.pathname === '/api/blackboard') {
      const state = await this.stateStore.getState('default');
      return this.jsonResponse(res, 200, state?.blackboard ?? {});
    }

    if (method === 'GET' && url.pathname === '/api/status') {
      const state = await this.stateStore.getState('default');
      return this.jsonResponse(res, 200, {
        lastMessageAt: state?.lastMessageAt ?? null,
        treeRootHash: state?.treeState.rootHash ?? null,
      });
    }

    if (method === 'GET' && url.pathname === '/api/tree') {
      // Create tree from factory to get structure (not state)
      const tree = this.createTree();
      // Reuse existing tree serializer if available
      // For now, return basic structure
      return this.jsonResponse(res, 200, { name: tree.name, rootHash: tree.rootHash });
    }

    // TODO: /api/nodes/:nodeId, /api/events (SSE), write endpoints (Task 96)

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private jsonResponse(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private serializeBlackboard(blackboard: any): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (typeof blackboard.entries === 'function') {
      for (const [key, value] of blackboard.entries()) {
        result[key] = value;
      }
    }
    return result;
  }
}
```

Note: Check the existing TreeServer implementation (`src/server/tree-server.ts`) and reuse patterns — HTTP utilities from `src/server/http-utils.ts`, existing API handlers from `src/server/api-handlers.ts`. The implementation above is a starting point; adapt to match existing patterns.

### Step 2: Write tests

Create `src/server/actor-server.test.ts`:

```ts
describe('ActorServer', () => {
  it('starts and responds to health check', async () => {
    const server = new ActorServer({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({ name: 'noop', action: async () => NodeStatus.SUCCESS }),
      }),
      port: 0, // random port
    });
    await server.start();

    const res = await fetch(`http://localhost:${actualPort}/_platform/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.uptime).toBeGreaterThanOrEqual(0);

    await server.stop();
  });

  it('initializes default state on first start', async () => {
    const store = new InMemoryStateStore();
    const server = new ActorServer({
      createTree: () => new BehaviorTree({ name: 'test', root: /* ... */ }),
      stateStore: store,
      context: { tenantId: 'abc' },
      port: 0,
    });
    await server.start();

    const state = await store.getState('default');
    expect(state).not.toBeNull();
    expect(state!.blackboard['context:tenantId']).toBe('abc');

    await server.stop();
  });

  it('GET /api/blackboard returns current blackboard', async () => {
    // ...
  });

  it('GET /api/status returns tree metadata', async () => {
    // ...
  });
});
```

Note: Getting the actual port when using port 0 requires `server.address()`. Check how the existing TreeServer tests handle this.

### Step 3: Run tests

Run: `npx vitest run src/server/actor-server.test.ts`

### Step 4: Typecheck + full suite

Run: `npm run typecheck && npm run test`

### Step 5: Commit

```bash
git add src/server/actor-server.ts src/server/actor-server.test.ts
git commit -m "feat(server): add ActorServer with config, health endpoint, and read endpoints"
```
