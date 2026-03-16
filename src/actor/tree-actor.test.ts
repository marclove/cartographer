import { describe, it, expect } from 'vitest';
import { TreeActor } from './tree-actor.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';
import { NodeStatus } from '../types.js';
import { untilSuccess } from '../decorators/until-success.js';
import { actionReceived } from '../nodes/action-received.js';

describe('TreeActor', () => {
  it('processes a tick message and saves state', async () => {
    const store = new InMemoryStateStore();
    const actor = new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({ name: 'fast', action: async () => NodeStatus.SUCCESS }),
      }),
      stateStore: store,
      stateKey: 'default',
    });

    const result = await actor.process({ type: 'tick' });
    expect(result.treeStatus).toBe(NodeStatus.SUCCESS);

    const saved = await store.getState('default');
    expect(saved).not.toBeNull();
    expect(saved!.treeState.rootHash).toBeDefined();
  });

  it('processes an action message — writes to blackboard then ticks', async () => {
    let receivedValue: unknown;
    const store = new InMemoryStateStore();
    const actor = new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({
          name: 'check',
          action: async (ctx) => {
            receivedValue = ctx.blackboard.get('actions:approve');
            return NodeStatus.SUCCESS;
          },
        }),
      }),
      stateStore: store,
      stateKey: 'default',
    });

    await actor.process({ type: 'action', name: 'approve', payload: { docId: '123' } });
    expect(receivedValue).toEqual({ docId: '123' });
  });

  it('runToCompletion ticks until suspended (not terminal)', async () => {
    const store = new InMemoryStateStore();
    const actor = new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: untilSuccess(actionReceived('approve')),
      }),
      stateStore: store,
      stateKey: 'default',
    });

    // No action present → actionReceived returns FAILURE → untilSuccess returns RUNNING
    const result = await actor.process({ type: 'tick' });
    expect(result.treeStatus).toBe(NodeStatus.RUNNING);
  });

  it('throws on topology mismatch with fail policy', async () => {
    const store = new InMemoryStateStore();

    const actor1 = new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({ name: 'v1', action: async () => NodeStatus.SUCCESS }),
      }),
      stateStore: store,
      stateKey: 'default',
    });
    await actor1.process({ type: 'tick' });

    const actor2 = new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({ name: 'v2', action: async () => NodeStatus.SUCCESS }),
      }),
      stateStore: store,
      stateKey: 'default',
      topologyPolicy: 'fail',
    });

    await expect(actor2.process({ type: 'tick' })).rejects.toThrow(/topology changed/i);
  });
});
