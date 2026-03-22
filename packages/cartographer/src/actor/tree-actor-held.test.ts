import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { NodeStatus } from '../types.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';
import { serializeTree } from '../core/serialization.js';
import { TreeActor } from './tree-actor.js';

function createSimpleTree() {
  return () => {
    const child = new ActionNode({
      name: 'test-action',
      action: (ctx) => {
        const val = ctx.blackboard.get<number>('counter') ?? 0;
        ctx.blackboard.set('counter', val + 1);
        return NodeStatus.SUCCESS;
      },
    });
    return new BehaviorTree({ name: 'test', root: child });
  };
}

async function seedHeldState(store: InMemoryStateStore, createTree: () => BehaviorTree) {
  const tree = createTree();
  tree.blackboard.set('counter', 5);
  const treeState = serializeTree(tree.root, tree.rootHash);
  await store.saveState('default', {
    blackboard: { counter: 5 },
    treeState,
    createdAt: Date.now(),
    lastMessageAt: Date.now(),
    held: true,
  });
}

describe('TreeActor held state', () => {
  it('tick message is a no-op when held', async () => {
    const createTree = createSimpleTree();
    const store = new InMemoryStateStore();
    await seedHeldState(store, createTree);

    const actor = new TreeActor({
      createTree,
      stateStore: store,
      stateKey: 'default',
    });

    const result = await actor.process({ type: 'tick' });
    expect(result.treeStatus).toBe(NodeStatus.RUNNING);
    expect(result.held).toBe(true);

    // Counter should NOT have incremented
    const state = await store.getState('default');
    expect(state?.blackboard.counter).toBe(5);
    expect(state?.held).toBe(true);
  });

  it('command message clears held and processes normally', async () => {
    const createTree = createSimpleTree();
    const store = new InMemoryStateStore();
    await seedHeldState(store, createTree);

    const actor = new TreeActor({
      createTree,
      stateStore: store,
      stateKey: 'default',
    });

    const result = await actor.process({
      type: 'command',
      name: 'go',
      payload: {},
    });
    expect(result.treeStatus).toBe(NodeStatus.SUCCESS);
    expect(result.held).toBeUndefined();

    // State should no longer be held
    const state = await store.getState('default');
    expect(state?.held).toBeFalsy();
  });

  it('write message clears held and processes normally', async () => {
    const createTree = createSimpleTree();
    const store = new InMemoryStateStore();
    await seedHeldState(store, createTree);

    const actor = new TreeActor({
      createTree,
      stateStore: store,
      stateKey: 'default',
    });

    const result = await actor.process({
      type: 'write',
      key: 'context:note',
      value: 'redirected',
    });
    expect(result.treeStatus).toBe(NodeStatus.SUCCESS);
    expect(result.held).toBeUndefined();

    const state = await store.getState('default');
    expect(state?.held).toBeFalsy();
    expect(state?.blackboard['context:note']).toBe('redirected');
  });

  it('signal:resume clears held without ticking', async () => {
    const createTree = createSimpleTree();
    const store = new InMemoryStateStore();
    await seedHeldState(store, createTree);

    const actor = new TreeActor({
      createTree,
      stateStore: store,
      stateKey: 'default',
    });

    const result = await actor.process({
      type: 'signal',
      signal: 'resume',
    });
    expect(result.treeStatus).toBe('error');
    expect(result.error).toContain('resume');

    // State should no longer be held, but counter unchanged
    const state = await store.getState('default');
    expect(state?.held).toBeFalsy();
    expect(state?.blackboard.counter).toBe(5);
  });

  it('non-held state processes tick normally', async () => {
    const createTree = createSimpleTree();
    const store = new InMemoryStateStore();

    const actor = new TreeActor({
      createTree,
      stateStore: store,
      stateKey: 'default',
    });

    const result = await actor.process({ type: 'tick' });
    expect(result.treeStatus).toBe(NodeStatus.SUCCESS);

    const state = await store.getState('default');
    expect(state?.blackboard.counter).toBe(1);
    expect(state?.held).toBeFalsy();
  });
});
