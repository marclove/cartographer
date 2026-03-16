import { describe, it, expect, vi } from 'vitest';
import { BaseNode } from './base.js';
import { ActionNode } from './action.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';

class TestNode extends BaseNode {
  public executeFn: (context: TreeContext) => Promise<NodeStatus> = async () => NodeStatus.SUCCESS;

  constructor(name: string, id?: string) {
    super(name, id);
  }

  setContextOverrides(overrides: Partial<TreeContext>): void {
    this.contextOverrides = overrides;
  }

  mergeContextOverrides(overrides: Partial<TreeContext>): void {
    this.contextOverrides = { ...this.contextOverrides, ...overrides };
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    return this.executeFn(context);
  }
}

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
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

  it('uses custom id when provided', () => {
    const node = new TestNode('my-node', 'custom-id-123');
    expect(node.id).toBe('custom-id-123');
  });

  it('generates UUID when id is not provided', () => {
    const node = new TestNode('my-node');
    expect(node.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('returns empty children array by default', () => {
    const node = new TestNode('leaf');
    expect(node.children).toEqual([]);
  });

  describe('hasInflightWork / inflightPromise', () => {
    it('returns false/null when no inflight state', () => {
      const node = new ActionNode({ name: 'test', action: async () => NodeStatus.SUCCESS });
      expect(node.hasInflightWork()).toBe(false);
      expect(node.inflightPromise()).toBeNull();
    });

    it('returns true after first tick starts async work', async () => {
      let resolve: (status: NodeStatus) => void;
      const node = new ActionNode({
        name: 'test',
        action: () => new Promise<NodeStatus>(r => { resolve = r; }),
      });
      const ctx = createContext();
      await node.tick(ctx);
      expect(node.hasInflightWork()).toBe(true);
      expect(node.inflightPromise()).toBeInstanceOf(Promise);
      resolve!(NodeStatus.SUCCESS);
    });

    it('returns false after promise settles but before collection tick', async () => {
      let resolve: (status: NodeStatus) => void;
      const node = new ActionNode({
        name: 'test',
        action: () => new Promise<NodeStatus>(r => { resolve = r; }),
      });
      const ctx = createContext();
      await node.tick(ctx);
      resolve!(NodeStatus.SUCCESS);
      await new Promise(r => setTimeout(r, 0));
      expect(node.hasInflightWork()).toBe(false);
      expect(node.inflightPromise()).toBeNull();
    });

    it('returns false after collection tick returns result', async () => {
      let resolve: (status: NodeStatus) => void;
      const node = new ActionNode({
        name: 'test',
        action: () => new Promise<NodeStatus>(r => { resolve = r; }),
      });
      const ctx = createContext();
      await node.tick(ctx);
      resolve!(NodeStatus.SUCCESS);
      await new Promise(r => setTimeout(r, 0));
      const status = await node.tick(ctx);
      expect(status).toBe(NodeStatus.SUCCESS);
      expect(node.hasInflightWork()).toBe(false);
    });
  });

  describe('contextOverrides', () => {
    it('merges contextOverrides onto the context passed to execute()', async () => {
      const node = new TestNode('node');
      const context = createContext();
      const handler = vi.fn();
      node.setContextOverrides({ onElicitation: handler } as Partial<TreeContext>);

      let receivedContext: TreeContext | undefined;
      node.executeFn = async (ctx) => {
        receivedContext = ctx;
        return NodeStatus.SUCCESS;
      };

      await node.tick(context);

      expect(receivedContext!.onElicitation).toBe(handler);
      expect(receivedContext!.events).toBe(context.events);
      expect(receivedContext!.blackboard).toBe(context.blackboard);
    });

    it('passes the original context when no overrides are set', async () => {
      const node = new TestNode('node');
      const context = createContext();

      let receivedContext: TreeContext | undefined;
      node.executeFn = async (ctx) => {
        receivedContext = ctx;
        return NodeStatus.SUCCESS;
      };

      await node.tick(context);

      expect(receivedContext!.blackboard).toBe(context.blackboard);
      expect(receivedContext!.events).toBe(context.events);
    });

    it('always preserves the original events emitter even when overrides include events', async () => {
      const node = new TestNode('node');
      const context = createContext();
      const otherEvents = new EventEmitter<TreeEvents>();
      node.setContextOverrides({ events: otherEvents } as Partial<TreeContext>);

      const originalSpy = vi.fn();
      const otherSpy = vi.fn();
      context.events.on('node:enter', originalSpy);
      otherEvents.on('node:enter', otherSpy);

      await node.tick(context);

      // events is never overridden — all events go to the tree-level emitter
      expect(originalSpy).toHaveBeenCalledOnce();
      expect(otherSpy).not.toHaveBeenCalled();
    });

    it('always preserves the original blackboard even when overrides include blackboard', async () => {
      const node = new TestNode('node');
      const context = createContext();
      const otherBlackboard = new InMemoryBlackboard();
      node.setContextOverrides({ blackboard: otherBlackboard } as Partial<TreeContext>);

      let receivedContext: TreeContext | undefined;
      node.executeFn = async (ctx) => {
        receivedContext = ctx;
        return NodeStatus.SUCCESS;
      };

      await node.tick(context);

      // blackboard is never overridden — the tree-level blackboard is always used
      expect(receivedContext!.blackboard).toBe(context.blackboard);
      expect(receivedContext!.blackboard).not.toBe(otherBlackboard);
    });

    it('mergeContextOverrides adds to existing overrides', async () => {
      const node = new TestNode('node');
      const context = createContext();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      node.setContextOverrides({ onElicitation: handler1 } as Partial<TreeContext>);
      node.mergeContextOverrides({ onElicitation: handler2 } as Partial<TreeContext>);

      let receivedContext: TreeContext | undefined;
      node.executeFn = async (ctx) => {
        receivedContext = ctx;
        return NodeStatus.SUCCESS;
      };

      await node.tick(context);

      // mergeContextOverrides overwrites existing keys
      expect(receivedContext!.onElicitation).toBe(handler2);
    });
  });
});
