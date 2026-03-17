import { describe, it, expect, afterEach } from 'vitest';
import { ActorServer } from './actor-server.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';
import { NodeStatus } from '../types.js';

function makeTree() {
  return new BehaviorTree({
    name: 'test',
    root: new ActionNode({ name: 'noop', action: async () => NodeStatus.SUCCESS }),
  });
}

describe('ActorServer', () => {
  let server: ActorServer;
  let port: number;

  afterEach(async () => {
    await server?.stop();
  });

  it('starts and responds to health check', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/_platform/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('initializes default state on first start', async () => {
    const store = new InMemoryStateStore();
    server = new ActorServer({
      createTree: makeTree,
      stateStore: store,
      context: { tenantId: 'abc' },
      port: 0,
    });
    await server.start();

    const state = await store.getState('default');
    expect(state).not.toBeNull();
    expect(state!.blackboard['context:tenantId']).toBe('abc');
  });

  it('GET /api/blackboard returns current blackboard', async () => {
    const store = new InMemoryStateStore();
    server = new ActorServer({ createTree: makeTree, stateStore: store, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/api/blackboard`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
  });

  it('GET /api/status returns tick stats', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tree).toBe('test');
    expect(body.tickCount).toBe(0);
    expect(body.cycleCount).toBe(0);
    expect(body.lastStatus).toBeNull();
    expect(body.lastDurationMs).toBeNull();
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/tree returns full tree structure', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/api/tree`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tree).toBe('test');
    expect(body.root).toBeDefined();
    expect(body.root.id).toBeDefined();
    expect(body.root.name).toBe('noop');
    expect(body.root.type).toBe('action');
    expect(Array.isArray(body.root.children)).toBe(true);
  });

  it('GET /api/nodes/:id returns node detail', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;

    const treeRes = await fetch(`http://localhost:${port}/api/tree`);
    const treeBody = await treeRes.json();
    const nodeId = treeBody.root.id;

    const res = await fetch(`http://localhost:${port}/api/nodes/${encodeURIComponent(nodeId)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(nodeId);
    expect(body.name).toBe('noop');
    expect(body.type).toBe('action');
  });

  it('GET /api/nodes/nonexistent returns 404', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/api/nodes/nonexistent-id`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown routes', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/unknown`);
    expect(res.status).toBe(404);
  });
});

describe('ActorServer write endpoints', () => {
  let server: ActorServer;
  let port: number;

  afterEach(async () => {
    await server?.stop();
  });

  it('POST /api/messages returns 202 with message ID', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;

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

  it('POST /api/messages returns 400 for missing type', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/actions/:name returns 202', async () => {
    const store = new InMemoryStateStore();
    server = new ActorServer({ createTree: makeTree, stateStore: store, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/api/actions/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId: '123' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.id).toBeDefined();
  });

  it('POST /api/blackboard/:key writes value', async () => {
    const store = new InMemoryStateStore();
    server = new ActorServer({ createTree: makeTree, stateStore: store, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/api/blackboard/myKey`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'hello' }),
    });
    expect(res.status).toBe(202);

    // Wait for processing
    await new Promise(r => setTimeout(r, 50));

    const bbRes = await fetch(`http://localhost:${port}/api/blackboard`);
    const bb = await bbRes.json();
    expect(bb.myKey).toBe('hello');
  });

  it('GET /api/events returns SSE stream with snapshot', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/api/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    // Read the first chunk (snapshot)
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const text = decoder.decode(value);
    expect(text).toContain('event: snapshot');
    expect(text).toContain('"blackboard"');
    reader.cancel();
  });

  it('emits message:processed event on success', async () => {
    const store = new InMemoryStateStore();
    server = new ActorServer({ createTree: makeTree, stateStore: store, port: 0 });
    port = (await server.start()).port;

    await fetch(`http://localhost:${port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tick' }),
    });

    // Wait for processing
    await new Promise(r => setTimeout(r, 50));

    // Check events in store — tree events now precede lifecycle events
    const events: Array<{ type: string }> = [];
    const iter = store.readEvents('default')[Symbol.asyncIterator]();
    let next = await iter.next();
    while (!next.done) {
      events.push(next.value);
      if (next.value.type === 'message:processed') break;
      next = await iter.next();
    }
    expect(events.some(e => e.type === 'message:processed')).toBe(true);
  });
});

describe('ActorServer /events SSE', () => {
  let server: ActorServer;
  let port: number;

  afterEach(async () => {
    await server?.stop();
  });

  /** Helper: parse SSE text into individual event objects. */
  function parseSseEvents(text: string): Array<{ id?: string; event?: string; data?: string }> {
    const results: Array<{ id?: string; event?: string; data?: string }> = [];
    const blocks = text.split('\n\n').filter(b => b.trim());
    for (const block of blocks) {
      const entry: Record<string, string> = {};
      for (const line of block.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          const value = line.slice(colonIdx + 1).trim();
          entry[key] = value;
        }
      }
      results.push(entry);
    }
    return results;
  }

  it('GET /events sends snapshot with tree structure on connect', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const text = decoder.decode(value);
    reader.cancel();

    const events = parseSseEvents(text);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const snapshot = events[0];
    expect(snapshot.event).toBe('snapshot');
    expect(snapshot.id).toBeDefined();

    const data = JSON.parse(snapshot.data!);
    expect(data.tree).toBeDefined();
    expect(data.tree.id).toBeDefined();
    expect(data.tree.name).toBe('noop');
    expect(data.tree.type).toBe('action');
    expect(Array.isArray(data.tree.children)).toBe(true);
    expect(data.blackboard).toBeDefined();
  });

  it('GET /events broadcasts tree events in real-time during message processing', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/events`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Read initial snapshot
    await reader.read();

    // Trigger a tick
    await fetch(`http://localhost:${port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tick' }),
    });

    // Collect SSE events until we see message:processed
    let collected = '';
    const timeout = Date.now() + 3000;
    while (Date.now() < timeout) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 200),
        ),
      ]);
      if (done && !value) break;
      if (value) collected += decoder.decode(value, { stream: true });
      if (collected.includes('message:processed')) break;
    }
    reader.cancel();

    const events = parseSseEvents(collected);
    const eventTypes = events.map(e => e.event).filter(Boolean);
    expect(eventTypes).toContain('message:processed');

    // Verify numeric monotonically-increasing IDs
    const ids = events.filter(e => e.id !== undefined).map(e => parseInt(e.id!, 10));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(Number.isInteger(id)).toBe(true);
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });
});
