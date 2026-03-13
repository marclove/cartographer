import { describe, it, expect, vi } from 'vitest';
import { ActionNode } from './action.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

describe('ActionNode', () => {
  it('returns the status from the action function', async () => {
    const node = new ActionNode({
      name: 'test-action',
      action: () => NodeStatus.SUCCESS,
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('supports async action functions', async () => {
    const node = new ActionNode({
      name: 'async-action',
      action: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return NodeStatus.FAILURE;
      },
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('passes TreeContext to the action function', async () => {
    const actionFn = vi.fn(() => NodeStatus.SUCCESS);
    const node = new ActionNode({ name: 'ctx-action', action: actionFn });
    const ctx = createContext();
    ctx.blackboard.set('key', 'value');
    await node.tick(ctx);
    expect(actionFn).toHaveBeenCalledWith(ctx);
  });

  it('returns FAILURE when action throws', async () => {
    const node = new ActionNode({
      name: 'error-action',
      action: () => {
        throw new Error('boom');
      },
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('accepts custom id via config', () => {
    const node = new ActionNode({ id: 'my-action', name: 'act', action: async () => NodeStatus.SUCCESS });
    expect(node.id).toBe('my-action');
  });

  it('can return RUNNING status', async () => {
    const node = new ActionNode({
      name: 'running-action',
      action: () => NodeStatus.RUNNING,
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });
});

describe('ActionNode inflight state', () => {
  /** Flush all pending microtasks so .then() handlers settle. */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('returns RUNNING on first tick even for fast actions', async () => {
    const node = new ActionNode({
      name: 'fast-action',
      action: async () => NodeStatus.SUCCESS,
    });
    const result = await node.tick(createContext());
    expect(result).toBe(NodeStatus.RUNNING);
  });

  it('returns final status on second tick after action resolves', async () => {
    let resolveAction!: (status: NodeStatus) => void;
    const action = vi.fn(
      async () => new Promise<NodeStatus>((r) => { resolveAction = r; }),
    );
    const node = new ActionNode({ name: 'deferred', action });
    const ctx = createContext();

    // First tick starts the action
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);

    // Resolve the action and flush microtasks
    resolveAction(NodeStatus.SUCCESS);
    await flush();

    // Second tick returns the final status
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('returns RUNNING while action is still pending (multiple poll ticks)', async () => {
    let resolveAction!: (status: NodeStatus) => void;
    const action = vi.fn(
      async () => new Promise<NodeStatus>((r) => { resolveAction = r; }),
    );
    const node = new ActionNode({ name: 'slow', action });
    const ctx = createContext();

    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);

    resolveAction(NodeStatus.FAILURE);
    await flush();

    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
  });

  it('handles action errors (returns FAILURE after error via BaseNode)', async () => {
    let rejectAction!: (err: Error) => void;
    const action = vi.fn(
      async () => new Promise<NodeStatus>((_, rej) => { rejectAction = rej; }),
    );
    const node = new ActionNode({ name: 'error-inflight', action });
    const ctx = createContext();

    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);

    rejectAction(new Error('async boom'));
    await flush();

    // BaseNode.tick() catches the re-thrown error and returns FAILURE
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
  });

  it('abort() clears inflight state — next tick starts fresh', async () => {
    let resolveAction!: (status: NodeStatus) => void;
    const action = vi.fn(
      async () => new Promise<NodeStatus>((r) => { resolveAction = r; }),
    );
    const node = new ActionNode({ name: 'abort-test', action });
    const ctx = createContext();

    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(action).toHaveBeenCalledTimes(1);

    node.abort();

    // Next tick starts a new invocation
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('reset() clears inflight state — next tick starts fresh', async () => {
    let resolveAction!: (status: NodeStatus) => void;
    const action = vi.fn(
      async () => new Promise<NodeStatus>((r) => { resolveAction = r; }),
    );
    const node = new ActionNode({ name: 'reset-test', action });
    const ctx = createContext();

    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(action).toHaveBeenCalledTimes(1);

    node.reset();

    // Next tick starts a new invocation
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('multiple ticks while RUNNING do not re-invoke the action function', async () => {
    let resolveAction!: (status: NodeStatus) => void;
    const action = vi.fn(
      async () => new Promise<NodeStatus>((r) => { resolveAction = r; }),
    );
    const node = new ActionNode({ name: 'no-reinvoke', action });
    const ctx = createContext();

    await node.tick(ctx);
    await node.tick(ctx);
    await node.tick(ctx);
    await node.tick(ctx);

    expect(action).toHaveBeenCalledTimes(1);

    resolveAction(NodeStatus.SUCCESS);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });
});
