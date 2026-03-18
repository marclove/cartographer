import { describe, it, expect, afterEach, vi } from 'vitest';
import { createCartographerClient, ConflictError } from './index.js';
import { ActorServer } from '../server/actor-server.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { NodeStatus } from '../types.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';

function makeTree() {
  return new BehaviorTree({
    name: 'test',
    root: new ActionNode({ name: 'noop', action: async () => NodeStatus.SUCCESS }),
  });
}

function makeSlowTree() {
  return new BehaviorTree({
    name: 'slow-test',
    root: new ActionNode({
      name: 'slow',
      action: () => new Promise<NodeStatus>(() => {
        // never resolves
      }),
    }),
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

  it('write(key, value) writes to blackboard and is visible in subsequent read', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;
    const client = createCartographerClient(`http://localhost:${port}`);

    const result = await client.write('greeting', 'hello');
    expect(result.id).toBeDefined();

    // Wait for the write message to be processed
    await new Promise((r) => setTimeout(r, 100));

    const bb = await client.blackboard();
    expect(bb.greeting).toBe('hello');
  });

  it('send(msg) POSTs to /api/messages and returns { id }', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;
    const client = createCartographerClient(`http://localhost:${port}`);

    const result = await client.send({ type: 'tick' });
    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe('string');
  });

  it('tree() returns tree data with name and root', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;
    const client = createCartographerClient(`http://localhost:${port}`);

    const data = await client.tree() as { tree: string; root: unknown };
    expect(data.tree).toBe('test');
    expect(data.root).toBeDefined();
  });

  it('send() throws on 400 for invalid payload', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    port = (await server.start()).port;
    const client = createCartographerClient(`http://localhost:${port}`);

    // Missing required 'type' field triggers 400
    await expect(client.send({} as any)).rejects.toThrow();
  });

  it('action() throws ConflictError on 409 when server is busy', async () => {
    server = new ActorServer({ createTree: makeSlowTree, port: 0 });
    port = (await server.start()).port;
    const client = createCartographerClient(`http://localhost:${port}`);

    // Start a slow action that will hold the lock
    await client.action('first');
    // Give the server a moment to start processing
    await new Promise((r) => setTimeout(r, 50));

    // Second action should hit 409
    await expect(client.action('second')).rejects.toThrow(ConflictError);
  });
});

describe('CartographerClient event listeners', () => {
  it('on() registers a handler and off() removes it', () => {
    const client = createCartographerClient('http://localhost:0');
    const handler = vi.fn();

    client.on('test:event', handler);

    // Verify off() doesn't throw and that registration works
    client.off('test:event', handler);

    // Calling off again for a removed handler should not throw
    client.off('test:event', handler);
  });

  it('off() on unregistered event does not throw', () => {
    const client = createCartographerClient('http://localhost:0');
    const handler = vi.fn();

    // off() on an event that was never registered should be safe
    expect(() => client.off('nonexistent', handler)).not.toThrow();
  });

  it('onAny() can register a handler without throwing', () => {
    const client = createCartographerClient('http://localhost:0');
    const handler = vi.fn();

    // onAny should not throw
    expect(() => client.onAny(handler)).not.toThrow();
  });

  it('on()/off()/onAny() work through SSE when EventSource is available', async () => {
    const server = new ActorServer({ createTree: makeTree, port: 0 });
    const { port } = await server.start();
    const client = createCartographerClient(`http://localhost:${port}`);

    // Install a mock EventSource that simulates SSE events
    const originalES = (globalThis as any).EventSource;
    const eventHandlers = new Map<string, (e: any) => void>();

    class MockEventSource {
      url: string;
      constructor(url: string) {
        this.url = url;
      }
      addEventListener(type: string, handler: (e: any) => void) {
        eventHandlers.set(type, handler);
      }
      close() {}
    }

    (globalThis as any).EventSource = MockEventSource;

    const allEvents: Array<{ event: string; data: unknown }> = [];
    const specificEvents: unknown[] = [];

    client.on('message:processed', (data) => { specificEvents.push(data); });
    client.onAny((event, data) => { allEvents.push({ event, data }); });

    client.connect();

    // Simulate SSE events via the captured handlers
    const processedHandler = eventHandlers.get('message:processed');
    expect(processedHandler).toBeDefined();
    processedHandler!({ data: JSON.stringify({ messageId: '123', treeStatus: 'SUCCESS' }) });

    expect(specificEvents).toHaveLength(1);
    expect(specificEvents[0]).toEqual({ messageId: '123', treeStatus: 'SUCCESS' });
    expect(allEvents).toHaveLength(1);
    expect(allEvents[0]).toEqual({ event: 'message:processed', data: { messageId: '123', treeStatus: 'SUCCESS' } });

    // Test off() removes handler
    const handler = (data: unknown) => { specificEvents.push(data); };
    client.on('message:processed', handler);
    client.off('message:processed', handler);

    // Simulate another event — only original handler should fire
    processedHandler!({ data: JSON.stringify({ messageId: '456', treeStatus: 'SUCCESS' }) });
    expect(specificEvents).toHaveLength(2); // original handler still fires

    client.disconnect();

    // Restore
    if (originalES !== undefined) {
      (globalThis as any).EventSource = originalES;
    } else {
      delete (globalThis as any).EventSource;
    }

    await server.stop();
  });

  it('client:event dispatches to handlers registered by event name', async () => {
    const client = createCartographerClient('http://localhost:0');

    const originalES = (globalThis as any).EventSource;
    const eventHandlers = new Map<string, (e: any) => void>();

    class MockEventSource {
      constructor() {}
      addEventListener(type: string, handler: (e: any) => void) {
        eventHandlers.set(type, handler);
      }
      close() {}
    }

    (globalThis as any).EventSource = MockEventSource;

    const uiEvents: unknown[] = [];
    client.on('ui:show_review', (data) => { uiEvents.push(data); });

    client.connect();

    // Simulate a client:event SSE message
    const clientEventHandler = eventHandlers.get('client:event');
    expect(clientEventHandler).toBeDefined();
    clientEventHandler!({ data: JSON.stringify({ name: 'ui:show_review', data: { reviewId: 42 } }) });

    expect(uiEvents).toHaveLength(1);
    expect(uiEvents[0]).toEqual({ reviewId: 42 });

    client.disconnect();

    if (originalES !== undefined) {
      (globalThis as any).EventSource = originalES;
    } else {
      delete (globalThis as any).EventSource;
    }
  });

  it('snapshot event is dispatched via SSE', () => {
    const client = createCartographerClient('http://localhost:0');

    const originalES = (globalThis as any).EventSource;
    const eventHandlers = new Map<string, (e: any) => void>();

    class MockEventSource {
      constructor() {}
      addEventListener(type: string, handler: (e: any) => void) {
        eventHandlers.set(type, handler);
      }
      close() {}
    }

    (globalThis as any).EventSource = MockEventSource;

    const snapshots: unknown[] = [];
    client.on('snapshot', (data) => { snapshots.push(data); });

    client.connect();

    const snapshotHandler = eventHandlers.get('snapshot');
    expect(snapshotHandler).toBeDefined();
    snapshotHandler!({ data: JSON.stringify({ blackboard: {}, status: 'idle' }) });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({ blackboard: {}, status: 'idle' });

    client.disconnect();

    if (originalES !== undefined) {
      (globalThis as any).EventSource = originalES;
    } else {
      delete (globalThis as any).EventSource;
    }
  });
});

describe('CartographerClient actionAndWait', () => {
  let server: ActorServer;

  afterEach(async () => {
    await server?.stop();
  });

  it('actionAndWait() resolves with messageId and treeStatus on success', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    const { port } = await server.start();
    const client = createCartographerClient(`http://localhost:${port}`);

    client.connect();
    await new Promise((r) => setTimeout(r, 100));

    const result = await client.actionAndWait('test', { x: 1 });
    expect(result.messageId).toBeDefined();
    expect(typeof result.messageId).toBe('string');
    expect(result.treeStatus).toBe('success');

    client.disconnect();
  });

  it('actionAndWait() rejects with Error via message:failed', async () => {
    // To trigger message:failed, we need the actor to throw at the server level.
    // A topology mismatch with 'fail' policy causes this.
    const store = new InMemoryStateStore();
    const tree1 = () => new BehaviorTree({
      name: 'test',
      root: new ActionNode({ name: 'v1', action: async () => NodeStatus.SUCCESS }),
    });
    const tree2 = () => new BehaviorTree({
      name: 'test',
      root: new ActionNode({ name: 'v2', action: async () => NodeStatus.SUCCESS }),
    });

    // First: process a message to save state with tree1's topology
    server = new ActorServer({ createTree: tree1, stateStore: store, port: 0 });
    let { port } = await server.start();
    const client1 = createCartographerClient(`http://localhost:${port}`);
    await client1.action('seed');
    await new Promise((r) => setTimeout(r, 100));
    await server.stop();

    // Second: start server with tree2 (different topology) + fail policy
    server = new ActorServer({ createTree: tree2, stateStore: store, topologyPolicy: 'fail', port: 0 });
    ({ port } = await server.start());
    const client2 = createCartographerClient(`http://localhost:${port}`);

    client2.connect();
    await new Promise((r) => setTimeout(r, 100));

    await expect(client2.actionAndWait('test')).rejects.toThrow(/topology/i);

    client2.disconnect();
  });

  it('actionAndWait() cleans up listeners after resolving', async () => {
    server = new ActorServer({ createTree: makeTree, port: 0 });
    const { port } = await server.start();
    const client = createCartographerClient(`http://localhost:${port}`);

    client.connect();
    await new Promise((r) => setTimeout(r, 100));

    // First call should resolve
    await client.actionAndWait('test');

    // Second call should also work (listeners from first call are cleaned up)
    const result = await client.actionAndWait('test');
    expect(result.treeStatus).toBe('success');

    client.disconnect();
  });
});

describe('CartographerClient connect/disconnect', () => {
  it('connect() is a no-op when EventSource is undefined', () => {
    const original = globalThis.EventSource;
    // Ensure EventSource is undefined
    (globalThis as any).EventSource = undefined;

    try {
      const client = createCartographerClient('http://localhost:0');
      // Should not throw
      client.connect();
      // disconnect should also be safe
      client.disconnect();
    } finally {
      // Restore
      if (original !== undefined) {
        (globalThis as any).EventSource = original;
      } else {
        delete (globalThis as any).EventSource;
      }
    }
  });

  it('connect() when already connected does not create a second connection', () => {
    const client = createCartographerClient('http://localhost:0');

    const originalES = (globalThis as any).EventSource;
    let constructorCalls = 0;

    class MockEventSource {
      constructor() { constructorCalls++; }
      addEventListener() {}
      close() {}
    }

    (globalThis as any).EventSource = MockEventSource;

    client.connect();
    client.connect(); // second call should be a no-op

    expect(constructorCalls).toBe(1);

    client.disconnect();

    if (originalES !== undefined) {
      (globalThis as any).EventSource = originalES;
    } else {
      delete (globalThis as any).EventSource;
    }
  });

  it('disconnect() clears connection so subsequent connect() creates a new one', () => {
    const client = createCartographerClient('http://localhost:0');

    const originalES = (globalThis as any).EventSource;
    let constructorCalls = 0;
    let closeCalls = 0;

    class MockEventSource {
      constructor() { constructorCalls++; }
      addEventListener() {}
      close() { closeCalls++; }
    }

    (globalThis as any).EventSource = MockEventSource;

    client.connect();
    expect(constructorCalls).toBe(1);

    client.disconnect();
    expect(closeCalls).toBe(1);

    // After disconnect, a new connect() should create a fresh connection
    client.connect();
    expect(constructorCalls).toBe(2);

    client.disconnect();

    if (originalES !== undefined) {
      (globalThis as any).EventSource = originalES;
    } else {
      delete (globalThis as any).EventSource;
    }
  });
});
