import { describe, it, expect, afterEach } from 'vitest';
import { ActorServer } from './actor-server.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';
import { NodeStatus } from '../types.js';
import { serializeTree } from '../core/serialization.js';

function makeSlowTree() {
  return new BehaviorTree({
    name: 'test',
    root: new ActionNode({
      name: 'slow',
      action: () => new Promise<NodeStatus>(() => {
        // never resolves — simulates a long-running agent
      }),
    }),
  });
}

function makeFastTree() {
  return new BehaviorTree({
    name: 'test',
    root: new ActionNode({
      name: 'fast',
      action: (ctx) => {
        const c = ctx.blackboard.get<number>('counter') ?? 0;
        ctx.blackboard.set('counter', c + 1);
        return NodeStatus.SUCCESS;
      },
    }),
  });
}

describe('ActorServer interrupt/resume endpoints', () => {
  let server: ActorServer;
  let port: number;

  afterEach(async () => {
    await server?.stop();
  });

  it('POST /api/interrupt while processing returns interrupted=true', async () => {
    const store = new InMemoryStateStore();
    server = new ActorServer({ createTree: makeSlowTree, stateStore: store, port: 0 });
    port = (await server.start()).port;

    // Start a slow message (will be processing)
    const commandRes = fetch(`http://localhost:${port}/api/commands/go`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    // Wait for processing to start
    await new Promise((r) => setTimeout(r, 50));

    // Interrupt
    const intRes = await fetch(`http://localhost:${port}/api/interrupt`, {
      method: 'POST',
    });
    expect(intRes.status).toBe(200);
    const intBody = await intRes.json() as any;
    expect(intBody.interrupted).toBe(true);

    // Wait for original request to complete
    const origRes = await commandRes;
    expect(origRes.status).toBe(202);

    // Wait a bit for async processing to complete
    await new Promise((r) => setTimeout(r, 50));

    // State should be held
    const state = await store.getState('default');
    expect(state?.held).toBe(true);
  });

  it('POST /api/interrupt when nothing is processing returns interrupted=false', async () => {
    server = new ActorServer({ createTree: makeFastTree, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/api/interrupt`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.interrupted).toBe(false);
  });

  it('POST /api/resume clears held state', async () => {
    const store = new InMemoryStateStore();
    server = new ActorServer({ createTree: makeFastTree, stateStore: store, port: 0 });
    port = (await server.start()).port;

    // Manually set held state
    const tree = makeFastTree();
    const treeState = serializeTree(tree.root, tree.rootHash);
    await store.saveState('default', {
      blackboard: {},
      treeState,
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      held: true,
    });

    const res = await fetch(`http://localhost:${port}/api/resume`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.resumed).toBe(true);

    const state = await store.getState('default');
    expect(state?.held).toBeFalsy();
  });

  it('POST /api/resume when not held returns resumed=false', async () => {
    server = new ActorServer({ createTree: makeFastTree, port: 0 });
    port = (await server.start()).port;

    const res = await fetch(`http://localhost:${port}/api/resume`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.resumed).toBe(false);
  });
});
