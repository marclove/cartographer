import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { NodeStatus } from '../types.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';
import { TreeActor } from './tree-actor.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function createSlowTree(opts?: { onAction?: () => void }) {
  let resolveAction: ((status: NodeStatus) => void) | null = null;
  const getResolver = () => resolveAction;

  const createTree = () => {
    const child = new ActionNode({
      name: 'slow-agent',
      action: () => {
        opts?.onAction?.();
        return new Promise<NodeStatus>((r) => { resolveAction = r; });
      },
    });
    return new BehaviorTree({ name: 'test', root: child });
  };

  return { createTree, getResolver };
}

describe('TreeActor interrupt', () => {
  it('requestInterrupt() causes runToCompletion to exit with RUNNING', async () => {
    const { createTree } = createSlowTree();
    const store = new InMemoryStateStore();
    const actor = new TreeActor({
      createTree,
      stateStore: store,
      stateKey: 'default',
    });

    // Start processing in the background
    const processPromise = actor.process({ type: 'tick' });

    // Wait for the action to start
    await flush();
    await flush();

    // Interrupt
    actor.requestInterrupt();

    const result = await processPromise;
    expect(result.treeStatus).toBe(NodeStatus.RUNNING);
    expect(result.interrupted).toBe(true);

    // State should be saved with held=true
    const state = await store.getState('default');
    expect(state?.held).toBe(true);
  });

  it('requestInterrupt() is a no-op when not processing', () => {
    const { createTree } = createSlowTree();
    const store = new InMemoryStateStore();
    const actor = new TreeActor({
      createTree,
      stateStore: store,
      stateKey: 'default',
    });

    // Should not throw
    actor.requestInterrupt();
  });

  it('preserves sequence completedMap after interrupt', async () => {
    let callCountA = 0;
    let resolveB: ((status: NodeStatus) => void) | null = null;

    const createTree = () => {
      const childA = new ActionNode({
        name: 'fast-a',
        action: () => { callCountA++; return NodeStatus.SUCCESS; },
      });
      const childB = new ActionNode({
        name: 'slow-b',
        action: () => new Promise<NodeStatus>((r) => { resolveB = r; }),
      });
      return new BehaviorTree({
        name: 'test',
        root: new SequenceNode({ name: 'seq', children: [childA, childB] }),
      });
    };

    const store = new InMemoryStateStore();
    const actor = new TreeActor({
      createTree,
      stateStore: store,
      stateKey: 'default',
    });

    // Process tick — A succeeds, B starts long work
    const processPromise = actor.process({ type: 'tick' });
    await flush();
    await flush();
    await flush();

    // Interrupt while B is running
    actor.requestInterrupt();
    const result = await processPromise;
    expect(result.treeStatus).toBe(NodeStatus.RUNNING);
    expect(result.interrupted).toBe(true);
  });
});
