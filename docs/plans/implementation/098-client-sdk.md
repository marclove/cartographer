# Task 98: Client SDK

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `createCartographerClient()` — a lightweight browser/Node client that connects to the ActorServer via REST and SSE.

**Depends on:** Tasks 096, 097 (ActorServer write endpoints + SSE)

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 5 (Client SDK Phase 1)

---

### Context

The client provides:
- `action()`, `write()`, `send()` — fire-and-forget message sending
- `actionAndWait()` — sends action, resolves on `message:processed`, rejects on `message:failed`
- `blackboard()`, `tree()`, `status()` — one-shot reads
- `on()`, `onAny()` — SSE event subscriptions
- `connect()`, `disconnect()` — SSE lifecycle
- 409 handling: rejects with `ConflictError`, no auto-retry

### Step 1: Create client types

Create `src/client/types.ts`:

```ts
export class ConflictError extends Error {
  constructor() {
    super('Session is currently processing a message');
    this.name = 'ConflictError';
  }
}

export interface CartographerClient {
  // Send messages (fire-and-forget)
  action(name: string, payload?: unknown): Promise<{ id: string }>;
  write(key: string, value: unknown): Promise<{ id: string }>;
  send(msg: { type: string; name?: string; payload?: unknown; key?: string; value?: unknown }): Promise<{ id: string }>;

  // Await completion
  actionAndWait(name: string, payload?: unknown): Promise<{ messageId: string; treeStatus: string }>;

  // Read state
  blackboard(): Promise<Record<string, unknown>>;
  tree(): Promise<unknown>;
  status(): Promise<unknown>;

  // Events
  on(event: string, handler: (data: unknown) => void): void;
  onAny(handler: (event: string, data: unknown) => void): void;
  off(event: string, handler: (data: unknown) => void): void;

  // SSE lifecycle
  connect(): void;
  disconnect(): void;
}
```

### Step 2: Implement client

Create `src/client/index.ts`:

```ts
import { ConflictError, type CartographerClient } from './types.js';

export { ConflictError, type CartographerClient } from './types.js';

export function createCartographerClient(baseUrl: string): CartographerClient {
  let eventSource: EventSource | null = null;
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const anyListeners = new Set<(event: string, data: unknown) => void>();

  async function post(path: string, body: unknown): Promise<{ id: string }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 409) throw new ConflictError();
    if (res.status === 400) {
      const err = await res.json();
      throw new Error(err.error ?? 'Bad request');
    }
    if (res.status === 503) throw new Error('Server is shutting down');
    return res.json();
  }

  async function get(path: string): Promise<unknown> {
    const res = await fetch(`${baseUrl}${path}`);
    return res.json();
  }

  function dispatchEvent(type: string, data: unknown): void {
    const handlers = listeners.get(type);
    if (handlers) {
      for (const handler of handlers) handler(data);
    }
    // Map client:event to friendly names
    if (type === 'client:event' && data && typeof data === 'object' && 'name' in data) {
      const ce = data as { name: string; data: unknown };
      const nameHandlers = listeners.get(ce.name);
      if (nameHandlers) {
        for (const handler of nameHandlers) handler(ce.data);
      }
    }
    for (const handler of anyListeners) handler(type, data);
  }

  return {
    async action(name, payload) {
      return post('/api/actions/' + encodeURIComponent(name), payload ?? {});
    },

    async write(key, value) {
      return post('/api/blackboard/' + encodeURIComponent(key), { value });
    },

    async send(msg) {
      return post('/api/messages', msg);
    },

    async actionAndWait(name, payload) {
      const { id } = await post('/api/actions/' + encodeURIComponent(name), payload ?? {});
      return new Promise((resolve, reject) => {
        const onProcessed = (data: unknown) => {
          const d = data as { messageId: string; treeStatus: string };
          if (d.messageId === id) {
            cleanup();
            resolve(d);
          }
        };
        const onFailed = (data: unknown) => {
          const d = data as { messageId: string; error: string };
          if (d.messageId === id) {
            cleanup();
            reject(new Error(d.error));
          }
        };
        const cleanup = () => {
          listeners.get('message:processed')?.delete(onProcessed);
          listeners.get('message:failed')?.delete(onFailed);
        };
        // Register temporary listeners
        if (!listeners.has('message:processed')) listeners.set('message:processed', new Set());
        if (!listeners.has('message:failed')) listeners.set('message:failed', new Set());
        listeners.get('message:processed')!.add(onProcessed);
        listeners.get('message:failed')!.add(onFailed);
      });
    },

    async blackboard() {
      return get('/api/blackboard') as Promise<Record<string, unknown>>;
    },

    async tree() {
      return get('/api/tree');
    },

    async status() {
      return get('/api/status');
    },

    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },

    onAny(handler) {
      anyListeners.add(handler);
    },

    off(event, handler) {
      listeners.get(event)?.delete(handler);
    },

    connect() {
      if (eventSource) return;
      eventSource = new EventSource(`${baseUrl}/api/events`);
      eventSource.addEventListener('snapshot', (e) => {
        dispatchEvent('snapshot', JSON.parse(e.data));
      });
      // Listen for all named events
      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          dispatchEvent('message', data);
        } catch {}
      };
      // Named events come through addEventListener
      for (const type of ['blackboard:write', 'client:event', 'message:processed', 'message:failed', 'node:enter', 'node:exit', 'tree:tick']) {
        eventSource.addEventListener(type, (e) => {
          try {
            dispatchEvent(type, JSON.parse((e as MessageEvent).data));
          } catch {}
        });
      }
    },

    disconnect() {
      eventSource?.close();
      eventSource = null;
    },
  };
}
```

Note: This uses browser `EventSource` API. For Node.js usage, consumers will need a polyfill (e.g., `eventsource` package). Document this in the export.

### Step 3: Write tests

Create `src/client/index.test.ts`. These need a running ActorServer — use integration-style tests:

```ts
describe('CartographerClient', () => {
  let server: ActorServer;
  let port: number;
  let client: CartographerClient;

  beforeEach(async () => {
    server = new ActorServer({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({ name: 'noop', action: async () => NodeStatus.SUCCESS }),
      }),
      port: 0,
    });
    await server.start();
    port = /* get actual port */;
    client = createCartographerClient(`http://localhost:${port}`);
  });

  afterEach(async () => {
    client.disconnect();
    await server.stop();
  });

  it('action() sends POST and returns message ID', async () => {
    const result = await client.action('test', { x: 1 });
    expect(result.id).toBeDefined();
  });

  it('action() rejects with ConflictError on 409', async () => {
    // Acquire lock manually to force 409
    // ...
    await expect(client.action('test')).rejects.toBeInstanceOf(ConflictError);
  });

  it('blackboard() returns current state', async () => {
    const bb = await client.blackboard();
    expect(bb).toBeDefined();
  });

  it('actionAndWait() resolves on message:processed', async () => {
    // This requires SSE connection
    client.connect();
    // Give SSE time to establish
    await new Promise(r => setTimeout(r, 100));

    const result = await client.actionAndWait('test', {});
    expect(result.treeStatus).toBeDefined();
  });
});
```

### Step 4: Run tests

Run: `npx vitest run src/client/`

### Step 5: Typecheck + full suite

Run: `npm run typecheck && npm run test`

### Step 6: Commit

```bash
git add src/client/types.ts src/client/index.ts src/client/index.test.ts
git commit -m "feat(client): add createCartographerClient SDK with REST, SSE, and actionAndWait"
```
