import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ActorServer } from '../server/actor-server.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { SequenceNode } from '../composites/sequence.js';
import { NodeStatus } from '../types.js';

let server: ActorServer;
let port: number;

function createTree() {
  const check = new ConditionNode({ name: 'CheckReady', id: 'check-ready', condition: async () => true });
  const act = new ActionNode({ name: 'DoWork', id: 'do-work', action: async () => NodeStatus.SUCCESS });
  const root = new SequenceNode({ name: 'Main', id: 'main', children: [check, act] });
  const bb = new InMemoryBlackboard({ env: 'test', 'scoped:key': 42 });
  return new BehaviorTree({ name: 'IntegrationTree', root, blackboard: bb });
}

beforeAll(async () => {
  server = new ActorServer({
    createTree,
    sessionId: 'default',
    port: 0,
  });
  ({ port } = await server.start());
});

afterAll(async () => {
  await server.stop();
});

describe('GET /api/tree', () => {
  it('returns full tree structure with hierarchy', async () => {
    const res = await fetch(`http://localhost:${port}/api/tree`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tree).toBe('IntegrationTree');
    expect(body.root.id).toBe('main');
    expect(body.root.type).toBe('sequence');
    expect(body.root.children).toHaveLength(2);
    expect(body.root.children[0].id).toBe('check-ready');
    expect(body.root.children[0].type).toBe('condition');
    expect(body.root.children[1].id).toBe('do-work');
    expect(body.root.children[1].type).toBe('action');
  });
});

describe('GET /api/status', () => {
  it('returns run status before any ticks', async () => {
    const res = await fetch(`http://localhost:${port}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tree).toBe('IntegrationTree');
    expect(body.tickCount).toBe(0);
    expect(body.lastStatus).toBeNull();
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('reflects status after a tick', async () => {
    await server.processMessage({ type: 'tick' }, 'default');
    const res = await fetch(`http://localhost:${port}/api/status`);
    const body = await res.json();
    expect(body.tickCount).toBeGreaterThanOrEqual(1);
    expect(body.lastStatus).toBe('success');
    expect(body.lastDurationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /api/blackboard', () => {
  it('returns blackboard snapshot with scoped keys', async () => {
    const res = await fetch(`http://localhost:${port}/api/blackboard`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.env).toBe('test');
    expect(body['scoped:key']).toBe(42);
  });
});

describe('GET /api/nodes/:id', () => {
  it('returns node detail for a valid ID', async () => {
    const res = await fetch(`http://localhost:${port}/api/nodes/check-ready`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('check-ready');
    expect(body.name).toBe('CheckReady');
    expect(body.type).toBe('condition');
  });

  it('returns 404 for unknown node ID', async () => {
    const res = await fetch(`http://localhost:${port}/api/nodes/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not found', status: 404 });
  });
});
