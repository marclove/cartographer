import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { createObserverApp } from './observer-app.js';
import type { ObserverHandle } from './observer-app.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { NodeStatus } from '../types.js';

function makeTree(): BehaviorTree {
  const action = new ActionNode({
    name: 'noop',
    action: async () => NodeStatus.SUCCESS,
  });
  return new BehaviorTree({ name: 'observer-tree', root: action });
}

function makeTreeWithChildren(): BehaviorTree {
  const a1 = new ActionNode({ name: 'child-1', action: async () => NodeStatus.SUCCESS });
  const a2 = new ActionNode({ name: 'child-2', action: async () => NodeStatus.SUCCESS });
  const seq = new SequenceNode({ name: 'parent', children: [a1, a2] });
  return new BehaviorTree({ name: 'tree-with-kids', root: seq });
}

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
        if (part.trim()) events.push(...parseSseEvents(part + '\n\n'));
      }
    }
  } catch { /* timeout */ } finally {
    timeout.removeEventListener('abort', onAbort);
    await reader.cancel();
  }
  return events;
}

describe('createObserverApp', () => {
  let tree: BehaviorTree;
  let handle: ObserverHandle;

  beforeEach(() => {
    tree = makeTree();
    handle = createObserverApp({ tree });
  });

  afterEach(() => {
    handle.close();
  });

  describe('GET /api/tree', () => {
    it('returns serialized tree structure', async () => {
      const res = await handle.app.request('/api/tree');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tree).toBe('observer-tree');
      expect(body.root.name).toBe('noop');
    });
  });

  describe('GET /api/status', () => {
    it('returns tree name and zero counters', async () => {
      const res = await handle.app.request('/api/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tree).toBe('observer-tree');
      expect(body.tickCount).toBe(0);
    });

    it('tracks tick count after ticking the tree', async () => {
      // First tick returns RUNNING (ActionNode captures result async)
      await tree.tick();
      // Second tick polls the result and returns SUCCESS
      await tree.tick();

      const res = await handle.app.request('/api/status');
      const body = await res.json();
      expect(body.tickCount).toBe(2);
      expect(body.lastStatus).toBe('success');
    });
  });

  describe('GET /api/blackboard', () => {
    it('returns live blackboard state from tree', async () => {
      tree.blackboard.set('test:key', 'value');
      const res = await handle.app.request('/api/blackboard');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body['test:key']).toBe('value');
    });
  });

  describe('GET /api/nodes/:id', () => {
    it('returns node detail', async () => {
      const t = makeTreeWithChildren();
      const h = createObserverApp({ tree: t });
      const treeRes = await h.app.request('/api/tree');
      const treeBody = await treeRes.json();
      const childId = treeBody.root.children[0].id;

      const res = await h.app.request(`/api/nodes/${childId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('child-1');
      h.close();
    });

    it('returns 404 for unknown node', async () => {
      const res = await handle.app.request('/api/nodes/fake-id');
      expect(res.status).toBe(404);
    });
  });

  describe('no health endpoint', () => {
    it('returns 404 for /_platform/health', async () => {
      const res = await handle.app.request('/_platform/health');
      expect(res.status).toBe(404);
    });
  });

  describe('no POST routes', () => {
    it('returns 404 for POST /api/messages', async () => {
      const res = await handle.app.request('/api/messages', { method: 'POST' });
      expect(res.status).toBe(404);
    });
  });

  describe('SSE streaming', () => {
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('sends snapshot without stats', async () => {
      const res = await fetch(`http://localhost:${port}/events`);
      const events = await readSseEvents(res, 1);
      expect(events[0].event).toBe('snapshot');
      const data = JSON.parse(events[0].data!);
      expect(data.tree).toBeDefined();
      expect(data.blackboard).toBeDefined();
      expect(data.stats).toBeUndefined();
    });

    it('forwards tree events to SSE clients', async () => {
      const res = await fetch(`http://localhost:${port}/events`);
      await tree.tick();

      const events = await readSseEvents(res, 3, 2000);
      expect(events[0].event).toBe('snapshot');
      expect(events.length).toBeGreaterThan(1);
    });
  });

  describe('close()', () => {
    it('unsubscribes from tree events', async () => {
      handle.close();
      // After close, ticking the tree should not cause errors
      await tree.tick();
    });
  });
});
