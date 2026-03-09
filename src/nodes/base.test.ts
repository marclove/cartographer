import { describe, it, expect, vi } from 'vitest';
import { BaseNode } from './base.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { MapBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';

class TestNode extends BaseNode {
  public executeFn: (context: TreeContext) => Promise<NodeStatus> = async () => NodeStatus.SUCCESS;

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    return this.executeFn(context);
  }
}

function createContext(): TreeContext {
  return {
    blackboard: new MapBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

describe('BaseNode', () => {
  it('generates a unique id', () => {
    const node1 = new TestNode('node-a');
    const node2 = new TestNode('node-b');
    expect(node1.id).toBeTruthy();
    expect(node2.id).toBeTruthy();
    expect(node1.id).not.toBe(node2.id);
  });

  it('stores the name', () => {
    const node = new TestNode('my-node');
    expect(node.name).toBe('my-node');
  });

  it('tick() returns the status from execute()', async () => {
    const node = new TestNode('node');
    node.executeFn = async () => NodeStatus.FAILURE;

    const status = await node.tick(createContext());
    expect(status).toBe(NodeStatus.FAILURE);
  });

  it('emits node:enter and node:exit events on tick', async () => {
    const node = new TestNode('node');
    const context = createContext();
    const enterSpy = vi.fn();
    const exitSpy = vi.fn();

    context.events.on('node:enter', enterSpy);
    context.events.on('node:exit', exitSpy);

    await node.tick(context);

    expect(enterSpy).toHaveBeenCalledOnce();
    expect(enterSpy).toHaveBeenCalledWith(expect.objectContaining({ node }));
    expect(exitSpy).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ node, status: NodeStatus.SUCCESS })
    );
  });

  it('emits node:exit with durationMs', async () => {
    const node = new TestNode('node');
    const context = createContext();
    const exitSpy = vi.fn();
    context.events.on('node:exit', exitSpy);

    await node.tick(context);

    expect(exitSpy.mock.calls[0][0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits node:error when execute throws', async () => {
    const node = new TestNode('node');
    const error = new Error('boom');
    node.executeFn = async () => { throw error; };

    const context = createContext();
    const errorSpy = vi.fn();
    context.events.on('node:error', errorSpy);

    const status = await node.tick(context);

    expect(status).toBe(NodeStatus.FAILURE);
    expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ node, error }));
  });

  it('reset() is callable', () => {
    const node = new TestNode('node');
    expect(() => node.reset()).not.toThrow();
  });

  it('abort() is callable', () => {
    const node = new TestNode('node');
    expect(() => node.abort()).not.toThrow();
  });
});
