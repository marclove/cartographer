import { describe, it, expect, afterEach } from 'vitest';
import { ObserverServer } from './observer-server.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import { ActionNode } from '../nodes/action.js';
import { NodeStatus } from '../types.js';

function createTestTree() {
  const root = new ActionNode({ name: 'TestAction', id: 'test-action', action: async () => NodeStatus.SUCCESS });
  return new BehaviorTree({ name: 'TestTree', root, blackboard: new InMemoryBlackboard() });
}

describe('ObserverServer', () => {
  let server: ObserverServer;

  afterEach(async () => {
    if (server) await server.close();
  });

  it('starts on specified port and responds to /api/status', async () => {
    const tree = createTestTree();
    server = new ObserverServer(tree, { port: 0 });
    const { port } = await server.start();

    const res = await fetch(`http://localhost:${port}/api/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.tree).toBe('TestTree');
  });

  it('returns 404 for unknown routes', async () => {
    const tree = createTestTree();
    server = new ObserverServer(tree, { port: 0 });
    const { port } = await server.start();

    const res = await fetch(`http://localhost:${port}/api/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('returns JSON error format', async () => {
    const tree = createTestTree();
    server = new ObserverServer(tree, { port: 0 });
    const { port } = await server.start();

    const res = await fetch(`http://localhost:${port}/api/nodes/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not found', status: 404 });
  });

  it('returns 404 for non-API, non-SSE routes', async () => {
    const tree = createTestTree();
    server = new ObserverServer(tree, { port: 0 });
    const { port } = await server.start();

    const res = await fetch(`http://localhost:${port}/index.html`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not found', status: 404 });
  });

  it('close() shuts down the server', async () => {
    const tree = createTestTree();
    server = new ObserverServer(tree, { port: 0 });
    const { port } = await server.start();
    await server.close();

    await expect(fetch(`http://localhost:${port}/api/status`)).rejects.toThrow();
  });

  it('GET /api/tree returns tree structure', async () => {
    const tree = createTestTree();
    server = new ObserverServer(tree, { port: 0 });
    const { port } = await server.start();

    const res = await fetch(`http://localhost:${port}/api/tree`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tree).toBe('TestTree');
    expect(body.root).toMatchObject({
      id: 'test-action',
      name: 'TestAction',
      type: 'action',
      children: [],
    });
  });

  it('GET /api/blackboard returns blackboard state', async () => {
    const bb = new InMemoryBlackboard();
    bb.set('greeting', 'hello');
    bb.set('count', 42);
    const root = new ActionNode({ name: 'TestAction', id: 'test-action', action: async () => NodeStatus.SUCCESS });
    const tree = new BehaviorTree({ name: 'TestTree', root, blackboard: bb });
    server = new ObserverServer(tree, { port: 0 });
    const { port } = await server.start();

    const res = await fetch(`http://localhost:${port}/api/blackboard`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ greeting: 'hello', count: 42 });
  });

  it('GET /events establishes SSE connection and receives a snapshot event', async () => {
    const tree = createTestTree();
    server = new ObserverServer(tree, { port: 0 });
    const { port } = await server.start();

    const controller = new AbortController();
    try {
      const res = await fetch(`http://localhost:${port}/events`, { signal: controller.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';

      // Read until we have a complete snapshot event
      while (!text.includes('event: snapshot')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }

      expect(text).toContain('event: snapshot');
      // Extract the data line for the snapshot event
      const dataMatch = text.match(/event: snapshot\ndata: (.+)\n/);
      expect(dataMatch).not.toBeNull();
      const snapshot = JSON.parse(dataMatch![1]);
      expect(snapshot.tree).toMatchObject({ id: 'test-action', name: 'TestAction' });
      expect(snapshot.blackboard).toBeDefined();
    } finally {
      controller.abort();
    }
  });

  it('tick stats tracking updates /api/status', async () => {
    const tree = createTestTree();
    server = new ObserverServer(tree, { port: 0 });
    const { port } = await server.start();

    // ActionNode uses inflight pattern: first tick returns RUNNING, second returns the actual result
    await tree.tick(); // RUNNING (launches action)
    await tree.tick(); // SUCCESS (collects result)

    const res = await fetch(`http://localhost:${port}/api/status`);
    const body = await res.json();
    expect(body.tickCount).toBe(2);
    expect(body.lastStatus).toBe(NodeStatus.SUCCESS);
    expect(body.cycleCount).toBe(1); // only the SUCCESS tick increments cycleCount
    expect(body.lastDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('tick stats tracking increments cycleCount only for terminal status', async () => {
    const tree = createTestTree();
    server = new ObserverServer(tree, { port: 0 });
    const { port } = await server.start();

    // First tick returns RUNNING (inflight pattern) — cycleCount should NOT increment
    await tree.tick();
    let res = await fetch(`http://localhost:${port}/api/status`);
    let body = await res.json();
    expect(body.tickCount).toBe(1);
    expect(body.lastStatus).toBe(NodeStatus.RUNNING);
    expect(body.cycleCount).toBe(0);

    // Second tick returns SUCCESS — cycleCount increments
    await tree.tick();
    res = await fetch(`http://localhost:${port}/api/status`);
    body = await res.json();
    expect(body.tickCount).toBe(2);
    expect(body.lastStatus).toBe(NodeStatus.SUCCESS);
    expect(body.cycleCount).toBe(1);
  });

  it('SSE event forwarding — tick events arrive via /events', async () => {
    const tree = createTestTree();
    server = new ObserverServer(tree, { port: 0 });
    const { port } = await server.start();

    const controller = new AbortController();
    try {
      const res = await fetch(`http://localhost:${port}/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';

      // Read the initial snapshot
      while (!text.includes('\n\n')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }

      // Now tick the tree to produce events
      await tree.tick();

      // Read the forwarded events
      text = '';
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !text.includes('event: tree:tick')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }

      expect(text).toContain('event: tree:tick');
      expect(text).toContain('event: node:enter');
      expect(text).toContain('event: node:exit');
    } finally {
      controller.abort();
    }
  });

  it('close() terminates SSE clients', async () => {
    const tree = createTestTree();
    server = new ObserverServer(tree, { port: 0 });
    const { port } = await server.start();

    const controller = new AbortController();
    let streamEnded = false;
    try {
      const res = await fetch(`http://localhost:${port}/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // Read the initial snapshot to confirm connection is established
      let text = '';
      while (!text.includes('event: snapshot')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      expect(text).toContain('event: snapshot');

      // Now close the server, which should end all SSE clients
      await server.close();

      // Subsequent reads should signal stream end
      const { done } = await reader.read();
      streamEnded = done;
    } catch {
      // AbortError or network error is also acceptable — connection was killed
      streamEnded = true;
    } finally {
      controller.abort();
    }

    expect(streamEnded).toBe(true);
  });
});
