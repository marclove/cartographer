import { describe, it, expect, afterEach } from 'vitest';
import { createCartographerClient, ConflictError } from './index.js';
import { ActorServer } from '../server/actor-server.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { NodeStatus } from '../types.js';

function makeTree() {
  return new BehaviorTree({
    name: 'test',
    root: new ActionNode({ name: 'noop', action: async () => NodeStatus.SUCCESS }),
  });
}

describe('CartographerClient', () => {
  let server: ActorServer;
  let port: number;

  afterEach(async () => {
    await server?.stop();
  });

  it('action() sends POST and returns message ID', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;
    const client = createCartographerClient(`http://localhost:${port}`);

    const result = await client.action('test', { x: 1 });
    expect(result.id).toBeDefined();
  });

  it('blackboard() returns current state', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;
    const client = createCartographerClient(`http://localhost:${port}`);

    const bb = await client.blackboard();
    expect(bb).toBeDefined();
  });

  it('status() returns tree metadata', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;
    const client = createCartographerClient(`http://localhost:${port}`);

    const status = await client.status();
    expect(status).toBeDefined();
  });

  it('ConflictError has correct name and message', () => {
    const err = new ConflictError();
    expect(err.name).toBe('ConflictError');
    expect(err.message).toBe('Session is currently processing a message');
    expect(err).toBeInstanceOf(Error);
  });
});
