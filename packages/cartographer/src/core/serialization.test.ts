import { describe, it, expect } from 'vitest';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { SequenceNode } from '../composites/sequence.js';
import { RetryNode } from '../decorators/retry.js';
import { RepeatNode } from '../decorators/repeat.js';
import { InverterNode } from '../decorators/inverter.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';
import { EventEmitter } from './event-emitter.js';
import { InMemoryBlackboard } from './blackboard.js';
import { SessionRegistry } from './session-registry.js';
import type { TreeEvents } from '../types.js';
import { buildHashIndex, serializeTree, restoreTree } from './serialization.js';
import type { SerializedTreeState } from './serialization.js';

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
    sessions: new SessionRegistry(),
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

describe('decorator serialization', () => {
  it('RetryNode serializes current attempt count', async () => {
    let callCount = 0;
    const child = new ActionNode({
      name: 'fail',
      action: async () => { callCount++; return NodeStatus.FAILURE; },
    });
    const retry = new RetryNode({ name: 'retry', child, maxAttempts: 5 });
    const ctx = createContext();

    // Tick: child starts → RUNNING
    await retry.tick(ctx);
    await flush();
    // Tick: child fails → retry increments attempt, child starts again → RUNNING
    await retry.tick(ctx);
    await flush();
    // Tick: child fails again → retry increments
    await retry.tick(ctx);

    const state = retry.serialize();
    expect(state.count).toBeGreaterThan(0);

    // Restore into fresh node
    const child2 = new ActionNode({ name: 'fail', action: async () => NodeStatus.FAILURE });
    const retry2 = new RetryNode({ name: 'retry', child: child2, maxAttempts: 5 });
    retry2.restore(state, new Map());
    expect(retry2.serialize().count).toBe(state.count);
  });

  it('RepeatNode serializes current iteration count', async () => {
    const child = new ActionNode({ name: 'ok', action: async () => NodeStatus.SUCCESS });
    const repeat = new RepeatNode({ name: 'repeat', child, count: 5 });
    const ctx = createContext();

    // Tick: child starts → RUNNING
    await repeat.tick(ctx);
    await flush();
    // Tick: child completes (iteration 1), starts again → RUNNING
    await repeat.tick(ctx);

    const state = repeat.serialize();
    expect(state.count).toBeGreaterThan(0);

    const child2 = new ActionNode({ name: 'ok', action: async () => NodeStatus.SUCCESS });
    const repeat2 = new RepeatNode({ name: 'repeat', child: child2, count: 5 });
    repeat2.restore(state, new Map());
    expect(repeat2.serialize().count).toBe(state.count);
  });

  it('InverterNode serializes empty state', () => {
    const child = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const inv = new InverterNode({ name: 'inv', child });
    expect(inv.serialize()).toEqual({});
  });
});

describe('buildHashIndex', () => {
  it('builds flat index from tree', () => {
    const a = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ name: 'b', action: async () => NodeStatus.SUCCESS });
    const seq = new SequenceNode({ name: 'seq', children: [a, b] });

    const index = buildHashIndex(seq);
    expect(index.size).toBe(3);
    expect(index.get(a.contentHash())).toBe(a);
    expect(index.get(b.contentHash())).toBe(b);
    expect(index.get(seq.contentHash())).toBe(seq);
  });

  it('disambiguates duplicate hashes', () => {
    const a1 = new ActionNode({ name: 'dup', action: async () => NodeStatus.SUCCESS });
    const a2 = new ActionNode({ name: 'dup', action: async () => NodeStatus.SUCCESS });
    const seq = new SequenceNode({ name: 'seq', children: [a1, a2] });

    const index = buildHashIndex(seq);
    const rawHash = a1.contentHash();
    expect(index.has(`${rawHash}:0`)).toBe(true);
    expect(index.has(`${rawHash}:1`)).toBe(true);
    expect(index.get(`${rawHash}:0`)).toBe(a1);
    expect(index.get(`${rawHash}:1`)).toBe(a2);
  });
});

describe('serializeTree / restoreTree', () => {
  it('round-trips tree state', async () => {
    const makeTree = () => {
      const a = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
      const b = new ActionNode({ name: 'b', action: async () => NodeStatus.SUCCESS });
      return new SequenceNode({ name: 'seq', children: [a, b] });
    };

    const tree1 = makeTree();
    const ctx = createContext();
    await tree1.tick(ctx);
    await flush();
    await tree1.tick(ctx);

    const rootHash = tree1.contentHash();
    const serialized = serializeTree(tree1, rootHash);

    const tree2 = makeTree();
    restoreTree(tree2, tree2.contentHash(), serialized);
    expect(serializeTree(tree2, tree2.contentHash())).toEqual(serialized);
  });

  it('throws on rootHash mismatch with fail policy', () => {
    const tree = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const stored: SerializedTreeState = { rootHash: 'wrong', nodes: {} };
    expect(() => restoreTree(tree, tree.contentHash(), stored, 'fail')).toThrow(/topology changed/i);
  });

  it('silently skips restore on rootHash mismatch with reset policy', () => {
    const tree = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const stored: SerializedTreeState = { rootHash: 'wrong', nodes: {} };
    expect(() => restoreTree(tree, tree.contentHash(), stored, 'reset')).not.toThrow();
  });
});
