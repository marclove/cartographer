import { describe, it, expect, afterEach } from 'vitest';
import { TreeServer } from './tree-server.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import { ActionNode } from '../nodes/action.js';
import { NodeStatus } from '../types.js';

function createTestTree() {
  const root = new ActionNode({ name: 'TestAction', id: 'test-action', action: async () => NodeStatus.SUCCESS });
  return new BehaviorTree({ name: 'TestTree', root, blackboard: new InMemoryBlackboard() });
}

describe('TreeServer', () => {
  let server: TreeServer;

  afterEach(async () => {
    if (server) await server.close();
  });

  it('starts on specified port and responds to /api/status', async () => {
    const tree = createTestTree();
    server = new TreeServer(tree, { port: 0 });
    const { port } = await server.start();

    const res = await fetch(`http://localhost:${port}/api/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.tree).toBe('TestTree');
  });

  it('returns 404 for unknown routes', async () => {
    const tree = createTestTree();
    server = new TreeServer(tree, { port: 0 });
    const { port } = await server.start();

    const res = await fetch(`http://localhost:${port}/api/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('returns JSON error format', async () => {
    const tree = createTestTree();
    server = new TreeServer(tree, { port: 0 });
    const { port } = await server.start();

    const res = await fetch(`http://localhost:${port}/api/nodes/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not found', status: 404 });
  });

  it('close() shuts down the server', async () => {
    const tree = createTestTree();
    server = new TreeServer(tree, { port: 0 });
    const { port } = await server.start();
    await server.close();

    await expect(fetch(`http://localhost:${port}/api/status`)).rejects.toThrow();
  });
});
