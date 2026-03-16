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

  it('GET /api/status returns tree metadata', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.treeRootHash).toBeDefined();
  });

  it('GET /api/tree returns tree structure', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/api/tree`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('test');
  });

  it('returns 404 for unknown routes', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/unknown`);
    expect(res.status).toBe(404);
  });
});
