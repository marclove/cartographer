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
