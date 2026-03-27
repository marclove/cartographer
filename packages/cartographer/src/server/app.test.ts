import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { serve } from '@hono/node-server';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import type { AppHandle } from './app.js';
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

describe('createApp — read-only routes', () => {
  let handle: AppHandle;

  beforeEach(async () => {
    handle = createApp({ createTree: makeTree });
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
      const h = createApp({
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
      const h = createApp({ createTree: makeTreeWithChildren });
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
      const h = createApp({
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

describe('createApp — SSE streaming', () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    handle = createApp({ createTree: makeTree });
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

describe('createApp — message processing', () => {
  let handle: AppHandle;

  beforeEach(async () => {
    handle = createApp({ createTree: makeTree });
    await handle.initializeState();
  });

  describe('processMessage (programmatic)', () => {
    it('processes a tick message and returns result', async () => {
      const result = await handle.processMessage({ type: 'tick' }, 'default');
      expect(result).toBeDefined();
      expect((result as any).queued).toBeUndefined();
      expect((result as any).treeStatus).toBeDefined();
    });

    it('queues a second message while one is processing', async () => {
      const slowHandle = createApp({
        createTree: () => {
          const action = new ActionNode({
            name: 'slow',
            action: () => new Promise((resolve) => setTimeout(() => resolve(NodeStatus.SUCCESS), 200)),
          });
          return new BehaviorTree({ name: 'slow', root: action });
        },
      });
      await slowHandle.initializeState();

      const first = slowHandle.processMessage({ type: 'tick' }, 'default');
      await new Promise((r) => setTimeout(r, 20));
      const second = await slowHandle.processMessage({ type: 'tick' }, 'default');

      expect(second).toBeDefined();
      expect((second as any).queued).toBe(true);

      await first;
    });

    it('returns null when queue is full', async () => {
      const slowHandle = createApp({
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

      const first = slowHandle.processMessage({ type: 'tick' }, 'default');
      await new Promise((r) => setTimeout(r, 20));

      await slowHandle.processMessage({ type: 'tick' }, 'default');
      const overflow = await slowHandle.processMessage({ type: 'tick' }, 'default');
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
      await handle.processMessage({ type: 'tick' }, 'default');

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

describe('createApp — interrupt and resume', () => {
  describe('POST /api/interrupt', () => {
    it('returns interrupted: false when no message is active', async () => {
      const handle = createApp({ createTree: makeTree });
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
      const handle = createApp({ createTree: makeSlowTree, stateStore: store });
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
      const handle = createApp({ createTree: makeTree });
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
      const handle = createApp({ createTree: makeTree, stateStore: store });
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

describe('createApp — bridgeTree', () => {
  it('forwards tree events to SSE clients', async () => {
    const handle = createApp({ createTree: makeTree });
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

// ---------- Auto-tick tests ----------

describe('createApp — autoTick', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends tick messages at the configured interval', async () => {
    let tickCount = 0;
    const handle = createApp({
      createTree: () => {
        const action = new ActionNode({
          name: 'counter',
          action: async () => { tickCount++; return NodeStatus.SUCCESS; },
        });
        return new BehaviorTree({ name: 'auto', root: action });
      },
      autoTick: { intervalMs: 100 },
    });
    await handle.initializeState();
    handle.startAutoTick();

    await vi.advanceTimersByTimeAsync(250);

    handle.stopAutoTick();
    expect(tickCount).toBe(2);
  });

  it('skips tick when previous is still in flight', async () => {
    let tickCount = 0;
    let resolvers: Array<() => void> = [];
    const handle = createApp({
      createTree: () => {
        const action = new ActionNode({
          name: 'slow',
          action: () => new Promise<NodeStatus>((resolve) => {
            tickCount++;
            resolvers.push(() => resolve(NodeStatus.SUCCESS));
          }),
        });
        return new BehaviorTree({ name: 'auto', root: action });
      },
      autoTick: { intervalMs: 50 },
    });
    await handle.initializeState();
    handle.startAutoTick();

    // First interval fires, starts a tick
    await vi.advanceTimersByTimeAsync(50);
    expect(tickCount).toBe(1);

    // Second interval fires while first is still in flight — should skip
    await vi.advanceTimersByTimeAsync(50);
    expect(tickCount).toBe(1);

    // Resolve the first tick
    resolvers[0]();
    await vi.advanceTimersByTimeAsync(0);

    // Third interval fires, should start a new tick
    await vi.advanceTimersByTimeAsync(50);
    expect(tickCount).toBe(2);

    resolvers[1]();
    handle.stopAutoTick();
  });

  it('does nothing when autoTick option is not set', async () => {
    const handle = createApp({ createTree: makeTree });
    await handle.initializeState();
    // Should be a no-op, not throw
    handle.startAutoTick();
    handle.stopAutoTick();
  });

  it('survives processMessage rejection and keeps ticking', async () => {
    let tickCount = 0;
    const handle = createApp({
      createTree: () => {
        const action = new ActionNode({
          name: 'flaky',
          action: async () => {
            tickCount++;
            if (tickCount === 1) throw new Error('boom');
            return NodeStatus.SUCCESS;
          },
        });
        return new BehaviorTree({ name: 'auto', root: action });
      },
      autoTick: { intervalMs: 100 },
    });
    await handle.initializeState();
    handle.startAutoTick();

    // First tick fires and the action throws — auto-tick should swallow it
    await vi.advanceTimersByTimeAsync(100);
    expect(tickCount).toBe(1);

    // Second tick should still fire
    await vi.advanceTimersByTimeAsync(100);
    expect(tickCount).toBe(2);

    handle.stopAutoTick();
  });

  it('stops cleanly via stopAutoTick', async () => {
    let tickCount = 0;
    const handle = createApp({
      createTree: () => {
        const action = new ActionNode({
          name: 'counter',
          action: async () => { tickCount++; return NodeStatus.SUCCESS; },
        });
        return new BehaviorTree({ name: 'auto', root: action });
      },
      autoTick: { intervalMs: 100 },
    });
    await handle.initializeState();
    handle.startAutoTick();

    await vi.advanceTimersByTimeAsync(100);
    expect(tickCount).toBe(1);

    handle.stopAutoTick();

    await vi.advanceTimersByTimeAsync(300);
    expect(tickCount).toBe(1);
  });
});

describe('createApp — lifecycle helpers', () => {
  it('nodeHandler() returns a working Node HTTP request listener', async () => {
    const handle = createApp({ createTree: makeTree });
    await handle.initializeState();

    const handler = handle.nodeHandler();
    expect(typeof handler).toBe('function');

    const server = createServer(handler);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => {
        resolve((server.address() as { port: number }).port);
      });
    });

    try {
      const res = await fetch(`http://localhost:${port}/_platform/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('start() initializes state but does not start auto-tick', async () => {
    vi.useFakeTimers();
    let tickCount = 0;
    const store = new InMemoryStateStore();
    const handle = createApp({
      createTree: () => {
        const action = new ActionNode({
          name: 'counter',
          action: async () => { tickCount++; return NodeStatus.SUCCESS; },
        });
        return new BehaviorTree({ name: 'lifecycle', root: action });
      },
      stateStore: store,
      autoTick: { intervalMs: 50 },
    });

    await handle.start();

    const state = await store.getState('default');
    expect(state).not.toBeNull();

    // auto-tick should NOT be running — caller starts it after server bind
    await vi.advanceTimersByTimeAsync(100);
    expect(tickCount).toBe(0);

    vi.useRealTimers();
  });

  it('stop() halts auto-tick and closes SSE clients', async () => {
    vi.useFakeTimers();
    let tickCount = 0;
    const handle = createApp({
      createTree: () => {
        const action = new ActionNode({
          name: 'counter',
          action: async () => { tickCount++; return NodeStatus.SUCCESS; },
        });
        return new BehaviorTree({ name: 'lifecycle', root: action });
      },
      autoTick: { intervalMs: 50 },
    });

    await handle.start();
    handle.startAutoTick();
    await vi.advanceTimersByTimeAsync(100);
    const countBeforeStop = tickCount;
    expect(countBeforeStop).toBeGreaterThanOrEqual(1);

    handle.stop();

    await vi.advanceTimersByTimeAsync(200);
    expect(tickCount).toBe(countBeforeStop);

    vi.useRealTimers();
  });
});

describe('createApp — session resolution', () => {
  it('resolveSessionId sets session on context for downstream routes', async () => {
    const handle = createApp({
      createTree: makeTree,
      resolveSessionId: () => 'user-42',
    });
    // Don't call initializeState — multi-session mode skips eager init
    // Blackboard for 'user-42' should be empty since no state exists
    const res = await handle.app.request('/api/blackboard');
    expect(res.status).toBe(200);
  });

  it('falls back to default when no resolver is provided', async () => {
    const handle = createApp({ createTree: makeTree });
    await handle.initializeState();

    const res = await handle.app.request('/api/blackboard');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
  });

  it('returns 401 when resolver returns empty string', async () => {
    const handle = createApp({
      createTree: makeTree,
      resolveSessionId: () => '',
    });

    const res = await handle.app.request('/api/blackboard');
    expect(res.status).toBe(401);
  });

  it('returns 401 when resolver returns null', async () => {
    const handle = createApp({
      createTree: makeTree,
      resolveSessionId: () => null as unknown as string,
    });

    const res = await handle.app.request('/api/blackboard');
    expect(res.status).toBe(401);
  });

  it('supports async resolveSessionId', async () => {
    const handle = createApp({
      createTree: makeTree,
      resolveSessionId: async () => 'async-user',
    });

    const res = await handle.app.request('/api/blackboard');
    expect(res.status).toBe(200);
  });

  it('health endpoint skips session resolution', async () => {
    const handle = createApp({
      createTree: makeTree,
      resolveSessionId: () => '',  // would 401 on session-scoped routes
    });

    const res = await handle.app.request('/_platform/health');
    expect(res.status).toBe(200);
  });
});

describe('createApp — auto-tick mutual exclusion', () => {
  it('throws when both resolveSessionId and autoTick are configured', () => {
    expect(() => createApp({
      createTree: makeTree,
      resolveSessionId: () => 'user-1',
      autoTick: { intervalMs: 100 },
    })).toThrow(/autoTick.*resolveSessionId/);
  });

  it('allows autoTick without resolveSessionId', () => {
    expect(() => createApp({
      createTree: makeTree,
      autoTick: { intervalMs: 100 },
    })).not.toThrow();
  });

  it('allows resolveSessionId without autoTick', () => {
    expect(() => createApp({
      createTree: makeTree,
      resolveSessionId: () => 'user-1',
    })).not.toThrow();
  });
});

describe('createApp — per-session interrupt', () => {
  it('interrupt for session A does not affect session B', async () => {
    const store = new InMemoryStateStore();
    const handle = createApp({
      createTree: makeSlowTree,
      stateStore: store,
      resolveSessionId: (c: any) => c.req.header('x-session-id') ?? 'default',
    });

    let server!: ReturnType<typeof serve>;
    let port!: number;
    await new Promise<void>((resolve) => {
      server = serve({ fetch: handle.app.fetch, port: 0 }, (info) => {
        port = info.port;
        resolve();
      });
    });

    // Start a slow message for session B
    fetch(`http://localhost:${port}/api/commands/go`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': 'session-b',
      },
      body: JSON.stringify({}),
    });
    await new Promise(r => setTimeout(r, 50));

    // Interrupt session A — should NOT interrupt session B
    const res = await fetch(`http://localhost:${port}/api/interrupt`, {
      method: 'POST',
      headers: { 'x-session-id': 'session-a' },
    });
    const body = await res.json();
    expect(body.interrupted).toBe(false);

    // Session B should still be processing (not interrupted)
    const resB = await fetch(`http://localhost:${port}/api/interrupt`, {
      method: 'POST',
      headers: { 'x-session-id': 'session-b' },
    });
    const bodyB = await resB.json() as any;
    expect(bodyB.interrupted).toBe(true);

    await new Promise(r => setTimeout(r, 50));
    handle.closeSseClients();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('createApp — multi-session integration', () => {
  function makeCounterTree(): BehaviorTree {
    return new BehaviorTree({
      name: 'counter',
      root: new ActionNode({
        name: 'increment',
        action: async (ctx) => {
          const count = (ctx.blackboard.get('count') as number) ?? 0;
          ctx.blackboard.set('count', count + 1);
          return NodeStatus.SUCCESS;
        },
      }),
    });
  }

  it('two sessions maintain independent blackboard state', async () => {
    const store = new InMemoryStateStore();
    const handle = createApp({
      createTree: makeCounterTree,
      stateStore: store,
      resolveSessionId: (c: any) => c.req.header('x-session-id') ?? 'default',
    });

    let server!: ReturnType<typeof serve>;
    let port!: number;
    await new Promise<void>((resolve) => {
      server = serve({ fetch: handle.app.fetch, port: 0 }, (info) => {
        port = info.port;
        resolve();
      });
    });

    // Tick session A three times
    for (let i = 0; i < 3; i++) {
      await fetch(`http://localhost:${port}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': 'session-a' },
        body: JSON.stringify({ type: 'tick' }),
      });
      await new Promise(r => setTimeout(r, 50));
    }

    // Tick session B once
    await fetch(`http://localhost:${port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': 'session-b' },
      body: JSON.stringify({ type: 'tick' }),
    });
    await new Promise(r => setTimeout(r, 50));

    // Verify independent state
    const bbA = await fetch(`http://localhost:${port}/api/blackboard`, {
      headers: { 'x-session-id': 'session-a' },
    }).then(r => r.json());
    expect(bbA.count).toBe(3);

    const bbB = await fetch(`http://localhost:${port}/api/blackboard`, {
      headers: { 'x-session-id': 'session-b' },
    }).then(r => r.json());
    expect(bbB.count).toBe(1);

    handle.closeSseClients();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('new session gets context values on first message', async () => {
    const store = new InMemoryStateStore();
    const handle = createApp({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({ name: 'noop', action: async () => NodeStatus.SUCCESS }),
      }),
      stateStore: store,
      context: { tenant: 'acme', env: 'staging' },
      resolveSessionId: (c: any) => c.req.header('x-session-id') ?? 'default',
    });

    let server!: ReturnType<typeof serve>;
    let port!: number;
    await new Promise<void>((resolve) => {
      server = serve({ fetch: handle.app.fetch, port: 0 }, (info) => {
        port = info.port;
        resolve();
      });
    });

    // Send first message to a new session
    await fetch(`http://localhost:${port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': 'new-user' },
      body: JSON.stringify({ type: 'tick' }),
    });
    await new Promise(r => setTimeout(r, 50));

    // Verify context values were applied
    const bb = await fetch(`http://localhost:${port}/api/blackboard`, {
      headers: { 'x-session-id': 'new-user' },
    }).then(r => r.json());
    expect(bb['context:tenant']).toBe('acme');
    expect(bb['context:env']).toBe('staging');

    handle.closeSseClients();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('resume is scoped to the resolved session', async () => {
    const store = new InMemoryStateStore();
    const handle = createApp({
      createTree: makeTree,
      stateStore: store,
      resolveSessionId: (c: any) => c.req.header('x-session-id') ?? 'default',
    });

    let server!: ReturnType<typeof serve>;
    let port!: number;
    await new Promise<void>((resolve) => {
      server = serve({ fetch: handle.app.fetch, port: 0 }, (info) => {
        port = info.port;
        resolve();
      });
    });

    // Create state for session A by sending a tick
    await fetch(`http://localhost:${port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': 'session-a' },
      body: JSON.stringify({ type: 'tick' }),
    });
    await new Promise(r => setTimeout(r, 50));

    // Set held manually
    const stateA = await store.getState('session-a');
    await store.saveState('session-a', { ...stateA!, held: true });

    // Resume session A
    const res = await fetch(`http://localhost:${port}/api/resume`, {
      method: 'POST',
      headers: { 'x-session-id': 'session-a' },
    });
    const body = await res.json() as any;
    expect(body.resumed).toBe(true);

    // Verify session A is no longer held
    const updatedA = await store.getState('session-a');
    expect(updatedA?.held).toBeFalsy();

    handle.closeSseClients();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('single-session mode works identically to previous behavior', async () => {
    const store = new InMemoryStateStore();
    const handle = createApp({
      createTree: makeTree,
      stateStore: store,
      context: { mode: 'single' },
    });
    await handle.initializeState();

    // Verify eager initialization
    const state = await store.getState('default');
    expect(state).not.toBeNull();
    expect(state!.blackboard['context:mode']).toBe('single');

    // processMessage still works with 'default'
    const result = await handle.processMessage({ type: 'tick' }, 'default');
    expect(result).toBeDefined();
    expect((result as any).treeStatus).toBeDefined();
  });

  it('start() drains queued messages for all sessions in multi-session mode', async () => {
    const store = new InMemoryStateStore();

    // Simulate queued messages left from a previous server instance
    // by manually enqueuing messages for two different sessions
    await store.enqueueMessage('session-x', { type: 'tick' }, 16);
    await store.enqueueMessage('session-y', { type: 'tick' }, 16);

    // We also need state to exist for listKeys to return these sessions
    // saveState implicitly registers the key
    const seedTree = makeTree();
    const { serializeTree: serializeTreeFn } = await import('../core/serialization.js');
    const seedState = {
      blackboard: {},
      treeState: serializeTreeFn(seedTree.root, seedTree.rootHash),
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
    };
    await store.saveState('session-x', seedState);
    await store.saveState('session-y', seedState);

    const handle = createApp({
      createTree: makeTree,
      stateStore: store,
      resolveSessionId: (c: any) => c.req.header('x-session-id') ?? 'default',
    });

    await handle.start();
    // Give drain time to process
    await new Promise(r => setTimeout(r, 100));

    // Both queues should be drained
    expect(await store.getQueueSize('session-x')).toBe(0);
    expect(await store.getQueueSize('session-y')).toBe(0);
  });
});

describe('createApp — stream eviction', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('evicts idle session streams after streamEvictionMs', async () => {
    const store = new InMemoryStateStore();
    const handle = createApp({
      createTree: makeTree,
      stateStore: store,
      streamEvictionMs: 1000,
    });
    await handle.initializeState();

    // Process a message — creates stream, events get IDs like 1, 2, 3...
    await handle.processMessage({ type: 'tick' }, 'default');

    // Connect SSE to get the latest event ID (proves stream has events)
    const res1 = await handle.app.request('/events');
    const reader1 = res1.body!.getReader();
    const { value: v1 } = await reader1.read();
    const text1 = new TextDecoder().decode(v1);
    await reader1.cancel();
    const idMatch = text1.match(/id: (\d+)/);
    expect(idMatch).not.toBeNull();
    const lastIdBeforeEviction = parseInt(idMatch![1], 10);
    expect(lastIdBeforeEviction).toBe(0); // snapshot id

    // Advance time past eviction TTL — stream gets deleted
    await vi.advanceTimersByTimeAsync(1500);

    // Process another message — creates a FRESH stream with IDs starting from 1
    await handle.processMessage({ type: 'tick' }, 'default');

    // The fresh stream's events start from 1 again (old stream's IDs are gone)
    const res2 = await handle.app.request('/events');
    const reader2 = res2.body!.getReader();
    const { value: v2 } = await reader2.read();
    const text2 = new TextDecoder().decode(v2);
    await reader2.cancel();
    // The snapshot's asOfEventId reflects the new stream's latest ID
    const data2 = JSON.parse(text2.split('data: ')[1].split('\n')[0]);
    // Fresh stream: IDs restarted from 1 (not continuing from the old stream)
    const newLatestId = parseInt(data2.stats.asOfEventId, 10);
    // If eviction didn't happen, the stream would still exist with IDs > lastIdBeforeEviction
    // After eviction + new message, the fresh stream has a small number of events
    expect(newLatestId).toBeGreaterThan(0);
    expect(newLatestId).toBeLessThan(20); // a single tick produces ~5-10 events
  });

  it('cancels eviction when a new message arrives for the session', async () => {
    const store = new InMemoryStateStore();
    const handle = createApp({
      createTree: makeTree,
      stateStore: store,
      streamEvictionMs: 1000,
    });
    await handle.initializeState();

    // Process first message — creates a stream
    await handle.processMessage({ type: 'tick' }, 'default');

    // Advance partway through eviction
    await vi.advanceTimersByTimeAsync(500);

    // Process second message — should reset the eviction timer
    await handle.processMessage({ type: 'tick' }, 'default');

    // Advance past original eviction time but not new one
    await vi.advanceTimersByTimeAsync(700);

    // Stream should still have events (not evicted)
    vi.useRealTimers();
    const res = await handle.app.request('/events', {
      headers: { 'Last-Event-ID': '0' },
    });
    const events = await readSseEvents(res, 3, 1000);
    // Should have replayed events from both ticks
    expect(events.length).toBeGreaterThan(1);
  });

  it('defaults to no eviction when streamEvictionMs is not set', async () => {
    const handle = createApp({
      createTree: makeTree,
    });
    await handle.initializeState();

    // Process a message
    await handle.processMessage({ type: 'tick' }, 'default');

    // Advance time significantly — stream should NOT be evicted
    await vi.advanceTimersByTimeAsync(600_000);

    // Replay should still work
    vi.useRealTimers();
    const res = await handle.app.request('/events', {
      headers: { 'Last-Event-ID': '0' },
    });
    const events = await readSseEvents(res, 3, 1000);
    expect(events.length).toBeGreaterThan(1);
  });
});
