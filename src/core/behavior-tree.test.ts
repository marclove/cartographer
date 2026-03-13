import { describe, it, expect, vi } from 'vitest';
import { BehaviorTree } from './behavior-tree.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { InMemoryBlackboard } from './blackboard.js';
import { EventEmitter } from './event-emitter.js';

describe('BehaviorTree', () => {
  it('tick() returns the root node status', async () => {
    const tree = new BehaviorTree({
      name: 'test-tree',
      root: new ActionNode({ name: 'root', action: () => NodeStatus.SUCCESS }),
    });
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('tick() returns FAILURE when root fails', async () => {
    const tree = new BehaviorTree({
      name: 'test-tree',
      root: new ActionNode({ name: 'root', action: () => NodeStatus.FAILURE }),
    });
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
    const result = await tree.run();
    expect(result.status).toBe(NodeStatus.SUCCESS);
    expect(result.blackboard.result).toBe('done');
  });

  it('events emitter is accessible', async () => {
    const tree = new BehaviorTree({
      name: 'test-tree',
      root: new ActionNode({ name: 'root', action: () => NodeStatus.SUCCESS }),
    });
    const enterSpy = vi.fn();
    tree.events.on('node:enter', enterSpy);
    await tree.tick();
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

    await tree.tick();

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ tree: 'my-tree', status: NodeStatus.SUCCESS })
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

    await tree.tick();
    expect(receivedContext!.onElicitation).toBe(handler);
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
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });
});
