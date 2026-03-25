import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { createCartographerApp } from './app.js';
import type { CartographerHandle } from './app.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { NodeStatus } from '../types.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';

function makeTree(): BehaviorTree {
  const action = new ActionNode({
    name: 'noop',
    action: async () => NodeStatus.SUCCESS,
  });
  return new BehaviorTree({ name: 'test-tree', root: action });
}

function makeTreeWithChildren(): BehaviorTree {
  const a1 = new ActionNode({ name: 'child-1', action: async () => NodeStatus.SUCCESS });
  const a2 = new ActionNode({ name: 'child-2', action: async () => NodeStatus.SUCCESS });
  const seq = new SequenceNode({ name: 'parent', children: [a1, a2] });
  return new BehaviorTree({ name: 'tree-with-children', root: seq });
}

describe('createCartographerApp — read-only routes', () => {
  let handle: CartographerHandle;

  beforeEach(async () => {
    handle = createCartographerApp({ createTree: makeTree });
    await handle.initializeState();
  });

  describe('GET /_platform/health', () => {
    it('returns ok with uptime in seconds', async () => {
      const res = await handle.app.request('/_platform/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(typeof body.uptime).toBe('number');
    });
  });

  describe('GET /api/status', () => {
    it('returns tree name and zero counters initially', async () => {
      const res = await handle.app.request('/api/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tree).toBe('test-tree');
      expect(body.tickCount).toBe(0);
      expect(body.cycleCount).toBe(0);
      expect(body.lastStatus).toBeNull();
    });
  });

  describe('GET /api/tree', () => {
    it('returns serialized tree structure', async () => {
      const res = await handle.app.request('/api/tree');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tree).toBe('test-tree');
      expect(body.root).toBeDefined();
      expect(body.root.name).toBe('noop');
      expect(body.root.type).toBe('action');
    });
  });

  describe('GET /api/blackboard', () => {
    it('returns blackboard state from store', async () => {
      const res = await handle.app.request('/api/blackboard');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body).toBe('object');
    });

    it('includes context values in initial blackboard', async () => {
      const h = createCartographerApp({
        createTree: makeTree,
        context: { tenant: 'acme' },
      });
      await h.initializeState();
      const res = await h.app.request('/api/blackboard');
      const body = await res.json();
      expect(body['context:tenant']).toBe('acme');
    });
  });

  describe('GET /api/nodes/:id', () => {
    it('returns node detail for a valid ID', async () => {
      const h = createCartographerApp({ createTree: makeTreeWithChildren });
      await h.initializeState();

      // Get tree to find a node ID
      const treeRes = await h.app.request('/api/tree');
      const treeBody = await treeRes.json();
      const childId = treeBody.root.children[0].id;

      const res = await h.app.request(`/api/nodes/${childId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('child-1');
      expect(body.type).toBe('action');
    });

    it('returns 404 for unknown node ID', async () => {
      const res = await handle.app.request('/api/nodes/does-not-exist');
      expect(res.status).toBe(404);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unmatched paths', async () => {
      const res = await handle.app.request('/api/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('error handling', () => {
    it('returns 500 JSON on unexpected errors', async () => {
      const h = createCartographerApp({
        createTree: () => { throw new Error('boom'); },
        stateStore: new InMemoryStateStore(),
      });
      // The routes that need readTree should return 500
      const res = await h.app.request('/api/tree');
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });
});

// ---------- SSE helpers ----------

function parseSseEvents(text: string): Array<{ id?: string; event?: string; data?: string }> {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const event: Record<string, string> = {};
      for (const line of block.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          const value = line.slice(colonIdx + 1).trim();
          event[key] = value;
        }
      }
      return event;
    });
}

async function readSseEvents(
  response: Response,
  count: number,
  timeoutMs = 3000,
): Promise<Array<{ id?: string; event?: string; data?: string }>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ id?: string; event?: string; data?: string }> = [];
  let buffer = '';

  const timeout = AbortSignal.timeout(timeoutMs);
  const onAbort = () => reader.cancel();
  timeout.addEventListener('abort', onAbort);

  try {
    while (events.length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop()!;
      for (const part of parts) {
        if (part.trim()) {
          events.push(...parseSseEvents(part + '\n\n'));
        }
      }
    }
  } catch {
    // timeout or cancel
  } finally {
    timeout.removeEventListener('abort', onAbort);
    await reader.cancel();
  }
  return events;
}

// ---------- SSE streaming tests ----------

describe('createCartographerApp — SSE streaming', () => {
  let handle: CartographerHandle;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    handle = createCartographerApp({ createTree: makeTree });
    await handle.initializeState();
    await new Promise<void>((resolve) => {
      server = serve({ fetch: handle.app.fetch, port: 0 }, (info) => {
        port = info.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    handle.closeSseClients();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends snapshot as first event', async () => {
    const res = await fetch(`http://localhost:${port}/events`);
    const events = await readSseEvents(res, 1);

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].event).toBe('snapshot');
    const data = JSON.parse(events[0].data!);
    expect(data.tree).toBeDefined();
    expect(data.blackboard).toBeDefined();
    expect(data.stats).toBeDefined();
  });
});

// ---------- Message processing tests ----------

describe('createCartographerApp — message processing', () => {
  let handle: CartographerHandle;

  beforeEach(async () => {
    handle = createCartographerApp({ createTree: makeTree });
    await handle.initializeState();
  });

  describe('processMessage (programmatic)', () => {
    it('processes a tick message and returns result', async () => {
      const result = await handle.processMessage({ type: 'tick' });
      expect(result).toBeDefined();
      expect((result as any).queued).toBeUndefined();
      expect((result as any).treeStatus).toBeDefined();
    });

    it('queues a second message while one is processing', async () => {
      const slowHandle = createCartographerApp({
        createTree: () => {
          const action = new ActionNode({
            name: 'slow',
            action: () => new Promise((resolve) => setTimeout(() => resolve(NodeStatus.SUCCESS), 200)),
          });
          return new BehaviorTree({ name: 'slow', root: action });
        },
      });
      await slowHandle.initializeState();

      const first = slowHandle.processMessage({ type: 'tick' });
      await new Promise((r) => setTimeout(r, 20));
      const second = await slowHandle.processMessage({ type: 'tick' });

      expect(second).toBeDefined();
      expect((second as any).queued).toBe(true);

      await first;
    });

    it('returns null when queue is full', async () => {
      const slowHandle = createCartographerApp({
        createTree: () => {
          const action = new ActionNode({
            name: 'slow',
            action: () => new Promise((resolve) => setTimeout(() => resolve(NodeStatus.SUCCESS), 500)),
          });
          return new BehaviorTree({ name: 'slow', root: action });
        },
        maxQueueDepth: 1,
      });
      await slowHandle.initializeState();

      const first = slowHandle.processMessage({ type: 'tick' });
      await new Promise((r) => setTimeout(r, 20));

      await slowHandle.processMessage({ type: 'tick' });
      const overflow = await slowHandle.processMessage({ type: 'tick' });
      expect(overflow).toBeNull();

      await first;
    });
  });

  describe('POST /api/messages', () => {
    let server: Server;
    let port: number;

    beforeEach(async () => {
      await new Promise<void>((resolve) => {
        server = serve({ fetch: handle.app.fetch, port: 0 }, (info) => {
          port = info.port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      handle.closeSseClients();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('accepts a tick message and returns 202', async () => {
      const res = await fetch(`http://localhost:${port}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'tick' }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.id).toBeDefined();
      expect(body.status).toBe('processing');
    });

    it('rejects missing message type with 400', async () => {
      const res = await fetch(`http://localhost:${port}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('rejects command without name with 400', async () => {
      const res = await fetch(`http://localhost:${port}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'command' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('SSE replay after processing', () => {
    let server: Server;
    let port: number;

    beforeEach(async () => {
      await new Promise<void>((resolve) => {
        server = serve({ fetch: handle.app.fetch, port: 0 }, (info) => {
          port = info.port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      handle.closeSseClients();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('replays events on reconnect via Last-Event-ID', async () => {
      await handle.processMessage({ type: 'tick' });

      const res = await fetch(`http://localhost:${port}/events`, {
        headers: { 'Last-Event-ID': '0' },
      });
      const events = await readSseEvents(res, 3);

      expect(events[0].event).toBe('snapshot');
      expect(events.length).toBeGreaterThan(1);
    });
  });

  describe('POST /api/commands/:name', () => {
    let server: Server;
    let port: number;

    beforeEach(async () => {
      await new Promise<void>((resolve) => {
        server = serve({ fetch: handle.app.fetch, port: 0 }, (info) => {
          port = info.port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      handle.closeSseClients();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('sends a command message and returns 202', async () => {
      const res = await fetch(`http://localhost:${port}/api/commands/doSomething`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'value' }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.status).toMatch(/processing|queued/);
    });
  });

  describe('POST /api/blackboard/:key', () => {
    let server: Server;
    let port: number;

    beforeEach(async () => {
      await new Promise<void>((resolve) => {
        server = serve({ fetch: handle.app.fetch, port: 0 }, (info) => {
          port = info.port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      handle.closeSseClients();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('writes a blackboard key and returns 202', async () => {
      const res = await fetch(`http://localhost:${port}/api/blackboard/myKey`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'hello' }),
      });
      expect(res.status).toBe(202);
    });
  });
});

// ---------- Interrupt, resume, bridgeTree tests ----------

function makeSlowTree(): BehaviorTree {
  return new BehaviorTree({
    name: 'slow',
    root: new ActionNode({
      name: 'slow',
      action: () => new Promise<NodeStatus>(() => {
        // never resolves — simulates a long-running agent
      }),
    }),
  });
}

describe('createCartographerApp — interrupt and resume', () => {
  describe('POST /api/interrupt', () => {
    it('returns interrupted: false when no message is active', async () => {
      const handle = createCartographerApp({ createTree: makeTree });
      await handle.initializeState();
      let server!: Server;
      let port!: number;
      await new Promise<void>((resolve) => {
        server = serve({ fetch: handle.app.fetch, port: 0 }, (info) => {
          port = info.port;
          resolve();
        });
      });

      const res = await fetch(`http://localhost:${port}/api/interrupt`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.interrupted).toBe(false);

      handle.closeSseClients();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('returns interrupted: true with messageId while processing', async () => {
      const store = new InMemoryStateStore();
      const handle = createCartographerApp({ createTree: makeSlowTree, stateStore: store });
      await handle.initializeState();
      let server!: Server;
      let port!: number;
      await new Promise<void>((resolve) => {
        server = serve({ fetch: handle.app.fetch, port: 0 }, (info) => {
          port = info.port;
          resolve();
        });
      });

      // Start a slow message (will be processing indefinitely)
      fetch(`http://localhost:${port}/api/commands/go`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      // Wait for processing to start
      await new Promise((r) => setTimeout(r, 50));

      // Interrupt
      const res = await fetch(`http://localhost:${port}/api/interrupt`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.interrupted).toBe(true);
      expect(body.messageId).toBeDefined();

      // Wait for async processing to finish
      await new Promise((r) => setTimeout(r, 50));

      // State should be held after interrupt
      const state = await store.getState('default');
      expect(state?.held).toBe(true);

      handle.closeSseClients();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });

  describe('POST /api/resume', () => {
    it('returns resumed: false when not held', async () => {
      const handle = createCartographerApp({ createTree: makeTree });
      await handle.initializeState();
      let server!: Server;
      let port!: number;
      await new Promise<void>((resolve) => {
        server = serve({ fetch: handle.app.fetch, port: 0 }, (info) => {
          port = info.port;
          resolve();
        });
      });

      const res = await fetch(`http://localhost:${port}/api/resume`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.resumed).toBe(false);

      handle.closeSseClients();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('clears held state and returns resumed: true', async () => {
      const store = new InMemoryStateStore();
      const handle = createCartographerApp({ createTree: makeTree, stateStore: store });
      await handle.initializeState();

      // Manually set held state on the store
      const state = await store.getState('default');
      await store.saveState('default', { ...state!, held: true });

      let server!: Server;
      let port!: number;
      await new Promise<void>((resolve) => {
        server = serve({ fetch: handle.app.fetch, port: 0 }, (info) => {
          port = info.port;
          resolve();
        });
      });

      const res = await fetch(`http://localhost:${port}/api/resume`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.resumed).toBe(true);

      // Verify held state is cleared
      const updated = await store.getState('default');
      expect(updated?.held).toBeFalsy();

      handle.closeSseClients();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });
});

describe('createCartographerApp — bridgeTree', () => {
  it('forwards tree events to SSE clients', async () => {
    const handle = createCartographerApp({ createTree: makeTree });
    await handle.initializeState();

    const tree = makeTree();
    handle.bridgeTree(tree);

    let server!: Server;
    let port!: number;
    await new Promise<void>((resolve) => {
      server = serve({ fetch: handle.app.fetch, port: 0 }, (info) => {
        port = info.port;
        resolve();
      });
    });

    const res = await fetch(`http://localhost:${port}/events`);
    await tree.tick();

    const events = await readSseEvents(res, 3, 2000);
    expect(events[0].event).toBe('snapshot');
    expect(events.length).toBeGreaterThan(1);

    handle.closeSseClients();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
