import { describe, it, expect, afterEach } from 'vitest';
import { ActorServer } from '../server/actor-server.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';
import { NodeStatus } from '../types.js';
import { serializeTree } from '../core/serialization.js';
import { createCartographerClient } from '@cartographer/client';

function makeSlowTree() {
  return new BehaviorTree({
    name: 'test',
    root: new ActionNode({
      name: 'slow',
      action: () => new Promise<NodeStatus>(() => {
        // never resolves
      }),
    }),
  });
}

function makeFastTree() {
  return new BehaviorTree({
    name: 'test',
    root: new ActionNode({
      name: 'fast',
      action: () => NodeStatus.SUCCESS,
    }),
  });
}

describe('CartographerClient interrupt/resume', () => {
  let server: ActorServer;
  let client: ReturnType<typeof createCartographerClient>;

  afterEach(async () => {
    client?.disconnect();
    await server?.stop();
  });

  it('interrupt() returns { interrupted: true } when processing', async () => {
    const store = new InMemoryStateStore();
    server = new ActorServer({ createTree: makeSlowTree, stateStore: store, port: 0 });
    const { port } = await server.start();
    client = createCartographerClient(`http://localhost:${port}`);

    // Start slow work
    await client.action('go');
    await new Promise((r) => setTimeout(r, 50));

    // Interrupt
    const result = await client.interrupt();
    expect(result.interrupted).toBe(true);

    // Wait for processing to settle
    await new Promise((r) => setTimeout(r, 50));

    const state = await store.getState('default');
    expect(state?.held).toBe(true);
  });

  it('interrupt() returns { interrupted: false } when idle', async () => {
    server = new ActorServer({ createTree: makeFastTree, port: 0 });
    const { port } = await server.start();
    client = createCartographerClient(`http://localhost:${port}`);

    const result = await client.interrupt();
    expect(result.interrupted).toBe(false);
  });

  it('resume() clears held state', async () => {
    const store = new InMemoryStateStore();
    server = new ActorServer({ createTree: makeFastTree, stateStore: store, port: 0 });
    const { port } = await server.start();
    client = createCartographerClient(`http://localhost:${port}`);

    // Set held state
    const tree = makeFastTree();
    const treeState = serializeTree(tree.root, tree.rootHash);
    await store.saveState('default', {
      blackboard: {},
      treeState,
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      held: true,
    });

    const result = await client.resume();
    expect(result.resumed).toBe(true);

    const state = await store.getState('default');
    expect(state?.held).toBeFalsy();
  });

  it('resume() returns { resumed: false } when not held', async () => {
    server = new ActorServer({ createTree: makeFastTree, port: 0 });
    const { port } = await server.start();
    client = createCartographerClient(`http://localhost:${port}`);

    const result = await client.resume();
    expect(result.resumed).toBe(false);
  });

  it('interruptAndAction() waits for SSE confirmation before sending action', async () => {
    const store = new InMemoryStateStore();
    server = new ActorServer({ createTree: makeSlowTree, stateStore: store, port: 0 });
    const { port } = await server.start();
    client = createCartographerClient(`http://localhost:${port}`);

    // Connect SSE so interruptAndAction can listen for message:processed
    client.connect();
    await new Promise((r) => setTimeout(r, 100));

    // Start slow work
    await client.action('go');
    await new Promise((r) => setTimeout(r, 50));

    // interruptAndAction: interrupts, waits for SSE confirmation, then sends action
    const result = await client.interruptAndAction('redirect', { target: 'new-path' });
    expect(result.id).toBeDefined();
  });

  it('interruptAndAction() sends action directly when nothing is processing', async () => {
    server = new ActorServer({ createTree: makeFastTree, port: 0 });
    const { port } = await server.start();
    client = createCartographerClient(`http://localhost:${port}`);

    // No SSE needed — fast path skips waiting
    const result = await client.interruptAndAction('go', {});
    expect(result.id).toBeDefined();
  });
});
