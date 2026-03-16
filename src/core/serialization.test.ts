import { describe, it, expect } from 'vitest';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { EventEmitter } from './event-emitter.js';
import { InMemoryBlackboard } from './blackboard.js';
import type { TreeEvents } from '../types.js';

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('leaf node serialization', () => {
  it('ActionNode serializes last terminal status', async () => {
    const node = new ActionNode({ name: 'test', action: async () => NodeStatus.SUCCESS });
    const ctx = createContext();
    await node.tick(ctx); // RUNNING (starts inflight)
    await flush();
    await node.tick(ctx); // SUCCESS (collects result)

    const state = node.serialize();
    expect(state.lastStatus).toBe(NodeStatus.SUCCESS);
  });

  it('ActionNode restores last terminal status', () => {
    const node = new ActionNode({ name: 'test', action: async () => NodeStatus.SUCCESS });
    node.restore({ lastStatus: NodeStatus.SUCCESS }, new Map());
    const state = node.serialize();
    expect(state.lastStatus).toBe(NodeStatus.SUCCESS);
  });

  it('unticked node serializes empty state', () => {
    const node = new ActionNode({ name: 'test', action: async () => NodeStatus.SUCCESS });
    expect(node.serialize()).toEqual({});
  });

  it('ConditionNode serializes empty state', () => {
    const node = new ConditionNode({ name: 'check', condition: () => true });
    expect(node.serialize()).toEqual({});
  });

  it('ActionNode FAILURE is serialized', async () => {
    const node = new ActionNode({ name: 'test', action: async () => NodeStatus.FAILURE });
    const ctx = createContext();
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    const state = node.serialize();
    expect(state.lastStatus).toBe(NodeStatus.FAILURE);
  });
});
