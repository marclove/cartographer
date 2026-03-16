import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BehaviorTree } from './behavior-tree.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { SequenceNode } from '../composites/sequence.js';
import { InMemoryBlackboard } from './blackboard.js';
import { EventEmitter } from './event-emitter.js';

const flush = () => new Promise(r => setTimeout(r, 0));

describe('BehaviorTree', () => {
  it('tick() returns the root node status', async () => {
    const tree = new BehaviorTree({
      name: 'test-tree',
      root: new ActionNode({ name: 'root', action: () => NodeStatus.SUCCESS }),
    });
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('tick() returns FAILURE when root fails', async () => {
    const tree = new BehaviorTree({
      name: 'test-tree',
      root: new ActionNode({ name: 'root', action: () => NodeStatus.FAILURE }),
    });
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.FAILURE);
  });

  it('provides a default blackboard', () => {
    const tree = new BehaviorTree({
      name: 'test-tree',
      root: new ActionNode({ name: 'root', action: () => NodeStatus.SUCCESS }),
    });
    expect(tree.blackboard).toBeDefined();
    tree.blackboard.set('key', 'value');
    expect(tree.blackboard.get('key')).toBe('value');
  });

  it('accepts a pre-populated blackboard', async () => {
    const bb = new InMemoryBlackboard({ initial: 42 });
    const tree = new BehaviorTree({
      name: 'test-tree',
      root: new ActionNode({
        name: 'root',
        action: (ctx) => {
          return ctx.blackboard.get<number>('initial') === 42
            ? NodeStatus.SUCCESS
            : NodeStatus.FAILURE;
        },
      }),
      blackboard: bb,
    });
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('run() returns status and blackboard snapshot', async () => {
    const tree = new BehaviorTree({
      name: 'test-tree',
      root: new ActionNode({
        name: 'root',
        action: (ctx) => {
          ctx.blackboard.set('result', 'done');
          return NodeStatus.SUCCESS;
        },
      }),
    });
    // First run returns RUNNING (action is inflight)
    const result1 = await tree.run();
    expect(result1.status).toBe(NodeStatus.RUNNING);

    await flush();

    // Second run returns SUCCESS with blackboard data
    const result2 = await tree.run();
    expect(result2.status).toBe(NodeStatus.SUCCESS);
    expect(result2.blackboard.result).toBe('done');
  });

  it('events emitter is accessible', async () => {
    const tree = new BehaviorTree({
      name: 'test-tree',
      root: new ActionNode({ name: 'root', action: () => NodeStatus.SUCCESS }),
    });
    const enterSpy = vi.fn();
    tree.events.on('node:enter', enterSpy);
    await tree.tick(); // starts inflight, still emits node:enter
    expect(enterSpy).toHaveBeenCalled();
  });

  it('reset() resets the root node', () => {
    const resetSpy = vi.fn();
    const root = new ActionNode({ name: 'root', action: () => NodeStatus.SUCCESS });
    root.reset = resetSpy;
    const tree = new BehaviorTree({ name: 'test-tree', root });
    tree.reset();
    expect(resetSpy).toHaveBeenCalled();
  });

  it('abort() aborts the root node', () => {
    const abortSpy = vi.fn();
    const root = new ActionNode({ name: 'root', action: () => NodeStatus.SUCCESS });
    root.abort = abortSpy;
    const tree = new BehaviorTree({ name: 'test-tree', root });
    tree.abort();
    expect(abortSpy).toHaveBeenCalled();
  });

  it('throws on duplicate node IDs', () => {
    const a = new ActionNode({ id: 'dupe', name: 'a', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ id: 'dupe', name: 'b', action: async () => NodeStatus.SUCCESS });
    const root = new SequenceNode({ name: 'root', children: [a, b] });

    expect(() => new BehaviorTree({ name: 'tree', root })).toThrow(/duplicate.*id/i);
  });

  it('allows unique custom IDs', () => {
    const a = new ActionNode({ id: 'node-a', name: 'a', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ id: 'node-b', name: 'b', action: async () => NodeStatus.SUCCESS });
    const root = new SequenceNode({ name: 'root', children: [a, b] });

    expect(() => new BehaviorTree({ name: 'tree', root })).not.toThrow();
  });

  it('detects duplicate IDs in nested trees', () => {
    const leaf = new ActionNode({ id: 'leaf', name: 'leaf', action: async () => NodeStatus.SUCCESS });
    const inner = new SequenceNode({ name: 'inner', children: [leaf] });
    const outerLeaf = new ActionNode({ id: 'leaf', name: 'leaf2', action: async () => NodeStatus.SUCCESS });
    const root = new SequenceNode({ name: 'root', children: [inner, outerLeaf] });

    expect(() => new BehaviorTree({ name: 'tree', root })).toThrow(/duplicate.*id.*leaf/i);
  });

  it('allows trees with auto-generated IDs', () => {
    const a = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ name: 'b', action: async () => NodeStatus.SUCCESS });
    const root = new SequenceNode({ name: 'root', children: [a, b] });

    expect(() => new BehaviorTree({ name: 'tree', root })).not.toThrow();
  });

  it('emits tree:init on construction', () => {
    const emitSpy = vi.spyOn(EventEmitter.prototype, 'emit');
    try {
      const tree = new BehaviorTree({
        name: 'my-tree',
        root: new ActionNode({ name: 'root-node', action: () => NodeStatus.SUCCESS }),
      });

      const initCall = emitSpy.mock.calls.find(([event]) => event === 'tree:init');
      expect(initCall).toBeDefined();
      expect(initCall![1]).toEqual({ tree: 'my-tree', root: 'root-node' });
    } finally {
      emitSpy.mockRestore();
    }
  });

  it('emits tree:tick after each tick', async () => {
    const tree = new BehaviorTree({
      name: 'my-tree',
      root: new ActionNode({ name: 'root', action: () => NodeStatus.SUCCESS }),
    });
    const spy = vi.fn();
    tree.events.on('tree:tick', spy);

    await tree.tick(); // RUNNING (inflight started)

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ tree: 'my-tree', status: NodeStatus.RUNNING })
    );
    expect(spy.mock.calls[0][0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits tree:reset on reset', () => {
    const tree = new BehaviorTree({
      name: 'my-tree',
      root: new ActionNode({ name: 'root', action: () => NodeStatus.SUCCESS }),
    });
    const spy = vi.fn();
    tree.events.on('tree:reset', spy);

    tree.reset();

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith({ tree: 'my-tree' });
  });

  it('emits tree:abort on abort', () => {
    const tree = new BehaviorTree({
      name: 'my-tree',
      root: new ActionNode({ name: 'root', action: () => NodeStatus.SUCCESS }),
    });
    const spy = vi.fn();
    tree.events.on('tree:abort', spy);

    tree.abort();

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith({ tree: 'my-tree' });
  });

  it('sets onElicitation as contextOverrides on the root when provided in config', async () => {
    const handler = vi.fn();
    let receivedContext: TreeContext | undefined;

    const tree = new BehaviorTree({
      name: 'test',
      root: new ActionNode({
        name: 'root',
        action: (ctx) => {
          receivedContext = ctx;
          return NodeStatus.SUCCESS;
        },
      }),
      onElicitation: handler,
    });

    await tree.tick(); // action starts inflight, context is captured
    expect(receivedContext!.onElicitation).toBe(handler);
  });

  it('emits blackboard:write when a node writes to the blackboard during a tick', async () => {
    const tree = new BehaviorTree({
      name: 'test-tree',
      root: new ActionNode({
        name: 'writer',
        action: (ctx) => {
          ctx.blackboard.set('key', 'value');
          return NodeStatus.SUCCESS;
        },
      }),
    });
    const spy = vi.fn();
    tree.events.on('blackboard:write', spy);

    await tree.tick(); // action runs in inflight, writes to blackboard
    await flush(); // let inflight complete

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith({ key: 'key', value: 'value', source: 'blackboard' });
  });

  it('emits blackboard:write with prefixed key for scoped writes', async () => {
    const tree = new BehaviorTree({
      name: 'test-tree',
      root: new ActionNode({
        name: 'writer',
        action: (ctx) => {
          const scoped = ctx.blackboard.scoped('agent');
          scoped.set('result', 42);
          return NodeStatus.SUCCESS;
        },
      }),
    });
    const spy = vi.fn();
    tree.events.on('blackboard:write', spy);

    await tree.tick(); // action runs in inflight, writes to blackboard
    await flush();

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith({ key: 'agent:result', value: 42, source: 'blackboard' });
  });

  it('nodes share the same blackboard through context', async () => {
    const tree = new BehaviorTree({
      name: 'test-tree',
      root: new SequenceNode({
        name: 'seq',
        children: [
          new ActionNode({
            name: 'writer',
            action: (ctx) => { ctx.blackboard.set('shared', 'hello'); return NodeStatus.SUCCESS; },
          }),
          new ActionNode({
            name: 'reader',
            action: (ctx) => {
              return ctx.blackboard.get('shared') === 'hello'
                ? NodeStatus.SUCCESS
                : NodeStatus.FAILURE;
            },
          }),
        ],
      }),
    });
    // Tick 1: writer starts inflight → RUNNING
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    // Tick 2: writer completes (cached), reader starts inflight → RUNNING
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    // Tick 3: writer cached, reader completes → SUCCESS
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });
});

describe('BehaviorTree hasInflightWork / settled', () => {
  it('returns false when tree has no inflight work', () => {
    const tree = new BehaviorTree({
      name: 'test',
      root: new ActionNode({ name: 'fast', action: async () => NodeStatus.SUCCESS }),
    });
    expect(tree.hasInflightWork()).toBe(false);
  });

  it('returns true when a node has inflight work', async () => {
    let resolve: (s: NodeStatus) => void;
    const tree = new BehaviorTree({
      name: 'test',
      root: new ActionNode({
        name: 'slow',
        action: () => new Promise<NodeStatus>(r => { resolve = r; }),
      }),
    });

    await tree.tick();
    expect(tree.hasInflightWork()).toBe(true);

    resolve!(NodeStatus.SUCCESS);
    await tree.settled();
    expect(tree.hasInflightWork()).toBe(false);
  });

  it('settled() resolves immediately when no inflight work', async () => {
    const tree = new BehaviorTree({
      name: 'test',
      root: new ActionNode({ name: 'fast', action: async () => NodeStatus.SUCCESS }),
    });
    await tree.settled();
  });

  it('settled() waits for deeply nested inflight work', async () => {
    let resolve: (s: NodeStatus) => void;
    const tree = new BehaviorTree({
      name: 'test',
      root: new SequenceNode({
        name: 'seq',
        children: [
          new ActionNode({
            name: 'slow',
            action: () => new Promise<NodeStatus>(r => { resolve = r; }),
          }),
        ],
      }),
    });

    await tree.tick();
    expect(tree.hasInflightWork()).toBe(true);

    const settledPromise = tree.settled();
    resolve!(NodeStatus.SUCCESS);
    await settledPromise;
    expect(tree.hasInflightWork()).toBe(false);
  });
});

describe('BehaviorTree.start()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeTree(bb?: InMemoryBlackboard) {
    const blackboard = bb ?? new InMemoryBlackboard({ ready: true });
    return new BehaviorTree({
      name: 'test-tree',
      root: new ConditionNode({
        name: 'check-ready',
        condition: (ctx) => ctx.blackboard.get<boolean>('ready') === true,
      }),
      blackboard,
    });
  }

  it('ticks the tree on interval', async () => {
    const tree = makeTree();
    const tickSpy = vi.spyOn(tree, 'tick');

    const handle = tree.start({ intervalMs: 100 });

    // No tick at t=0
    expect(tickSpy).not.toHaveBeenCalled();

    // Advance past one interval
    await vi.advanceTimersByTimeAsync(100);
    expect(tickSpy).toHaveBeenCalledTimes(1);

    // Advance past another interval
    await vi.advanceTimersByTimeAsync(100);
    expect(tickSpy).toHaveBeenCalledTimes(2);

    await handle.stop();
  });

  it('returns handle with stop()', async () => {
    const tree = makeTree();
    const tickSpy = vi.spyOn(tree, 'tick');

    const handle = tree.start({ intervalMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    expect(tickSpy).toHaveBeenCalledTimes(1);

    await handle.stop();

    // After stop, no more ticks should fire
    await vi.advanceTimersByTimeAsync(200);
    expect(tickSpy).toHaveBeenCalledTimes(1);
  });

  it('throws if already running', async () => {
    const tree = makeTree();

    const handle = tree.start({ intervalMs: 100 });

    expect(() => tree.start({ intervalMs: 100 })).toThrow(
      /tick loop is already running/i,
    );

    await handle.stop();
  });

  it('after stop(), start() can be called again', async () => {
    const tree = makeTree();
    const tickSpy = vi.spyOn(tree, 'tick');

    const handle1 = tree.start({ intervalMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    expect(tickSpy).toHaveBeenCalledTimes(1);

    await handle1.stop();

    // Start again
    const handle2 = tree.start({ intervalMs: 50 });

    await vi.advanceTimersByTimeAsync(50);
    expect(tickSpy).toHaveBeenCalledTimes(2);

    await handle2.stop();
  });

  it('signal option stops the loop', async () => {
    const tree = makeTree();
    const tickSpy = vi.spyOn(tree, 'tick');

    const ac = new AbortController();
    tree.start({ intervalMs: 100, signal: ac.signal });

    await vi.advanceTimersByTimeAsync(100);
    expect(tickSpy).toHaveBeenCalledTimes(1);

    ac.abort();

    // After abort, no more ticks
    await vi.advanceTimersByTimeAsync(200);
    expect(tickSpy).toHaveBeenCalledTimes(1);
  });

  it('manual stop removes abort listener from signal', async () => {
    const tree = makeTree();
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

    const handle = tree.start({ intervalMs: 100, signal: ac.signal });
    await handle.stop();

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
