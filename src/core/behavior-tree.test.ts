import { describe, it, expect, vi } from 'vitest';
import { BehaviorTree } from './behavior-tree.js';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { MapBlackboard } from './blackboard.js';

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
    const bb = new MapBlackboard({ initial: 42 });
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
