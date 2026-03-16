import { describe, it, expect } from 'vitest';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { SequenceNode } from '../composites/sequence.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';
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

describe('composite serialization', () => {
  it('SequenceNode round-trips completedMap', async () => {
    const a = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ name: 'b', action: async () => NodeStatus.SUCCESS });
    const seq = new SequenceNode({ name: 'seq', children: [a, b] });
    const ctx = createContext();

    // Tick until 'a' completes and is in completedMap
    await seq.tick(ctx); // a starts → RUNNING
    await flush();
    await seq.tick(ctx); // a completes → SUCCESS, b starts → RUNNING

    // Serialize
    const state = seq.serialize();
    expect(state.completedMap).toBeDefined();
    expect(state.completedMap![a.contentHash()]).toBe(NodeStatus.SUCCESS);

    // Create fresh tree and restore
    const a2 = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const b2 = new ActionNode({ name: 'b', action: async () => NodeStatus.SUCCESS });
    const seq2 = new SequenceNode({ name: 'seq', children: [a2, b2] });

    const hashToNode = new Map<string, BTreeNode>();
    hashToNode.set(a2.contentHash(), a2);
    hashToNode.set(b2.contentHash(), b2);

    seq2.restore(state, hashToNode);

    // Verify completedMap was restored with live references
    const restored = seq2.serialize();
    expect(restored.completedMap![a2.contentHash()]).toBe(NodeStatus.SUCCESS);
  });

  it('completedMap survives full serialize/restore cycle (mid-sequence)', async () => {
    // Two children: first completes, second is still RUNNING → completedMap has first
    let resolveB: (s: NodeStatus) => void;
    const a = new ActionNode({ name: 'check', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ name: 'pending', action: () => new Promise<NodeStatus>(r => { resolveB = r; }) });
    const seq = new SequenceNode({ name: 'seq', children: [a, b] });
    const ctx = createContext();

    // Tick: a starts → RUNNING
    await seq.tick(ctx);
    await flush();
    // Tick: a completes → SUCCESS, b starts → RUNNING
    await seq.tick(ctx);

    // Sequence is mid-cycle: a is in completedMap, b is running
    const state = seq.serialize();
    expect(state.completedMap?.[a.contentHash()]).toBe(NodeStatus.SUCCESS);

    // Restore into fresh tree
    const a2 = new ActionNode({ name: 'check', action: async () => NodeStatus.SUCCESS });
    const b2 = new ActionNode({ name: 'pending', action: async () => NodeStatus.SUCCESS });
    const seq2 = new SequenceNode({ name: 'seq', children: [a2, b2] });
    const index = new Map<string, BTreeNode>([
      [a2.contentHash(), a2],
      [b2.contentHash(), b2],
    ]);
    seq2.restore(state, index);

    const restoredState = seq2.serialize();
    expect(restoredState.completedMap?.[a2.contentHash()]).toBe(NodeStatus.SUCCESS);

    resolveB!(NodeStatus.SUCCESS);
  });
});
