import { describe, it, expect, vi } from 'vitest';
import { ActionNode } from './action.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { MapBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';

function createContext(): TreeContext {
  return {
    blackboard: new MapBlackboard(),
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

  it('can return RUNNING status', async () => {
    const node = new ActionNode({
      name: 'running-action',
      action: () => NodeStatus.RUNNING,
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });
});
