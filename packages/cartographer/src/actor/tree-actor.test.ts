import { describe, it, expect } from 'vitest';
import { TreeActor } from './tree-actor.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { InMemoryStateStore } from '../state/in-memory-state-store.js';
import { NodeStatus } from '../types.js';
import { untilSuccess } from '../decorators/until-success.js';
import { receive } from '../nodes/receive.js';
import { SessionRegistry } from '../core/session-registry.js';

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

  it('processes a command message — writes to blackboard then ticks', async () => {
    let receivedValue: unknown;
    const store = new InMemoryStateStore();
    const actor = new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({
          name: 'check',
          action: async (ctx) => {
            receivedValue = ctx.blackboard.get('commands:approve');
            return NodeStatus.SUCCESS;
          },
        }),
      }),
      stateStore: store,
      stateKey: 'default',
    });

    await actor.process({ type: 'command', name: 'approve', payload: { docId: '123' } });
    expect(receivedValue).toEqual({ docId: '123' });
  });

  it('runToCompletion ticks until suspended (not terminal)', async () => {
    const store = new InMemoryStateStore();
    const actor = new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: untilSuccess(receive('approve')),
      }),
      stateStore: store,
      stateKey: 'default',
    });

    // No action present → receive returns FAILURE → untilSuccess returns RUNNING
    const result = await actor.process({ type: 'tick' });
    expect(result.treeStatus).toBe(NodeStatus.RUNNING);
  });

  it('signal:reset resets tree and saves state', async () => {
    const store = new InMemoryStateStore();
    let resetCalled = false;

    const createTree = () => {
      const tree = new BehaviorTree({
        name: 'test',
        root: new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS }),
      });
      const origReset = tree.reset.bind(tree);
      tree.reset = () => { resetCalled = true; origReset(); };
      return tree;
    };

    // First tick to seed state
    const actor1 = new TreeActor({ createTree, stateStore: store, stateKey: 'default' });
    await actor1.process({ type: 'tick' });

    // Now send a reset signal
    const actor2 = new TreeActor({ createTree, stateStore: store, stateKey: 'default' });
    const result = await actor2.process({ type: 'signal', signal: 'reset' });

    expect(result.treeStatus).toBe('error');
    expect(result.error).toContain('reset');
    expect(resetCalled).toBe(true);

    const saved = await store.getState('default');
    expect(saved).not.toBeNull();
    expect(saved!.treeState).toBeDefined();
  });

  it('signal:abort aborts tree and saves state', async () => {
    const store = new InMemoryStateStore();
    let abortCalled = false;

    const createTree = () => {
      const tree = new BehaviorTree({
        name: 'test',
        root: new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS }),
      });
      const origAbort = tree.abort.bind(tree);
      tree.abort = () => { abortCalled = true; origAbort(); };
      return tree;
    };

    // Seed state
    const actor1 = new TreeActor({ createTree, stateStore: store, stateKey: 'default' });
    await actor1.process({ type: 'tick' });

    // Send abort signal
    const actor2 = new TreeActor({ createTree, stateStore: store, stateKey: 'default' });
    const result = await actor2.process({ type: 'signal', signal: 'abort' });

    expect(result.treeStatus).toBe('error');
    expect(result.error).toContain('abort');
    expect(abortCalled).toBe(true);

    const saved = await store.getState('default');
    expect(saved).not.toBeNull();
  });

  it('processes a write message — sets blackboard key and ticks', async () => {
    let receivedValue: unknown;
    const store = new InMemoryStateStore();
    const actor = new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({
          name: 'reader',
          action: async (ctx) => {
            receivedValue = ctx.blackboard.get('foo');
            return NodeStatus.SUCCESS;
          },
        }),
      }),
      stateStore: store,
      stateKey: 'default',
    });

    const result = await actor.process({ type: 'write', key: 'foo', value: 'bar' });
    expect(result.treeStatus).toBe(NodeStatus.SUCCESS);
    expect(receivedValue).toBe('bar');

    const saved = await store.getState('default');
    expect(saved!.blackboard.foo).toBe('bar');
  });

  it('re-throws non-interrupted errors from tick', async () => {
    const store = new InMemoryStateStore();
    let tickCount = 0;
    const actor = new TreeActor({
      createTree: () => {
        const tree = new BehaviorTree({
          name: 'test',
          root: new ActionNode({ name: 'ok', action: async () => NodeStatus.RUNNING }),
        });
        // Override tick to throw a non-interrupt error on the first call
        const origTick = tree.tick.bind(tree);
        tree.tick = async () => {
          tickCount++;
          if (tickCount === 1) throw new Error('kaboom');
          return origTick();
        };
        return tree;
      },
      stateStore: store,
      stateKey: 'default',
    });

    await expect(actor.process({ type: 'tick' })).rejects.toThrow('kaboom');
  });

  it('runToCompletion handles inflight work that settles normally', async () => {
    const store = new InMemoryStateStore();
    let resolveAction: ((status: NodeStatus) => void) | null = null;
    let tickCount = 0;

    const actor = new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({
          name: 'delayed',
          action: () => {
            tickCount++;
            // First invocation: return a delayed promise (creates inflight work)
            // When polled after settle, the result is collected and returned
            return new Promise<NodeStatus>((resolve) => {
              resolveAction = resolve;
              // Resolve after a short delay so settled() fires
              setTimeout(() => resolve(NodeStatus.SUCCESS), 10);
            });
          },
        }),
      }),
      stateStore: store,
      stateKey: 'default',
    });

    const result = await actor.process({ type: 'tick' });

    // The tree should have completed successfully after inflight work settled
    expect(result.treeStatus).toBe(NodeStatus.SUCCESS);
    expect(result.interrupted).toBeUndefined();
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

describe('TreeActor - sessions', () => {
  it('serializes session registry in saved state', async () => {
    const store = new InMemoryStateStore();
    // Use a tick counter in a closure so it persists across process() calls
    let tickCount = 0;
    const actor = new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({
          name: 'writer',
          action: async (ctx) => {
            tickCount++;
            // First tick: write a session and return a delayed RUNNING (inflight work).
            // After the inflight settles, runToCompletion ticks again. Subsequent ticks
            // return synchronous RUNNING (no inflight), which triggers suspension detection
            // after two consecutive no-inflight RUNNING results.
            if (tickCount === 1) {
              ctx.sessions.set('triage', 'session-abc');
              return new Promise<NodeStatus>((resolve) => setTimeout(() => resolve(NodeStatus.RUNNING), 5));
            }
            // Ticks 2+ return synchronous RUNNING (no inflight) → suspension detected
            return NodeStatus.RUNNING;
          },
        }),
      }),
      stateStore: store,
      stateKey: 'default',
    });

    const result = await actor.process({ type: 'tick' });
    expect(result.treeStatus).toBe(NodeStatus.RUNNING);

    const saved = await store.getState('default');
    expect(saved).not.toBeNull();
    expect(saved!.sessions).toEqual({ triage: 'session-abc' });
  });

  it('restores session registry from loaded state', async () => {
    const store = new InMemoryStateStore();
    let seenSessionId: string | undefined;

    // Use the same node name in both seed and reader to avoid topology mismatch.
    // First pass seeds state and returns RUNNING (with sessions saved after implementation).
    // We'll inject sessions manually into the store after the first tick.
    let tickCount = 0;
    const createTree = () => new BehaviorTree({
      name: 'test',
      root: new ActionNode({
        name: 'action',
        action: async (ctx) => {
          tickCount++;
          if (tickCount === 1) {
            // First process: suspend with RUNNING so state is saved
            return new Promise<NodeStatus>((resolve) => setTimeout(() => resolve(NodeStatus.RUNNING), 5));
          }
          // Second process: read the session and return SUCCESS
          seenSessionId = ctx.sessions.get('triage');
          return NodeStatus.SUCCESS;
        },
      }),
    });

    // First tick — suspends with RUNNING
    const actor1 = new TreeActor({ createTree, stateStore: store, stateKey: 'default' });
    await actor1.process({ type: 'tick' });

    // Inject sessions into saved state
    const existing = await store.getState('default');
    await store.saveState('default', { ...existing!, sessions: { triage: 'restored-id' } });

    // Second tick — reads sessions from restored state
    const actor2 = new TreeActor({ createTree, stateStore: store, stateKey: 'default' });
    await actor2.process({ type: 'tick' });
    expect(seenSessionId).toBe('restored-id');
  });

  it('handles missing sessions field (backward compatibility)', async () => {
    const store = new InMemoryStateStore();
    let seenSessionId: string | undefined;
    let tickCount = 0;

    const createTree = () => new BehaviorTree({
      name: 'test',
      root: new ActionNode({
        name: 'action',
        action: async (ctx) => {
          tickCount++;
          if (tickCount === 1) {
            // First process: suspend with RUNNING so state is saved
            return new Promise<NodeStatus>((resolve) => setTimeout(() => resolve(NodeStatus.RUNNING), 5));
          }
          seenSessionId = ctx.sessions.get('triage');
          return NodeStatus.SUCCESS;
        },
      }),
    });

    // First tick — suspends with RUNNING
    const actor1 = new TreeActor({ createTree, stateStore: store, stateKey: 'default' });
    await actor1.process({ type: 'tick' });

    // Remove sessions field to simulate old serialized state without sessions
    const existing = await store.getState('default');
    const { sessions: _sessions, ...withoutSessions } = existing!;
    await store.saveState('default', withoutSessions as typeof existing);

    // Second tick — should work fine with empty sessions (backward compat)
    const actor2 = new TreeActor({ createTree, stateStore: store, stateKey: 'default' });
    const result = await actor2.process({ type: 'tick' });
    expect(result.treeStatus).toBe(NodeStatus.SUCCESS);
    expect(seenSessionId).toBeUndefined();
  });

  it('clears sessions when tree reaches terminal status', async () => {
    const store = new InMemoryStateStore();

    // First, seed state with sessions via a suspending tick
    let tickCount = 0;
    const createTree = () => new BehaviorTree({
      name: 'test',
      root: new ActionNode({
        name: 'action',
        action: async (ctx) => {
          tickCount++;
          if (tickCount === 1) {
            ctx.sessions.set('triage', 'session-xyz');
            return new Promise<NodeStatus>((resolve) => setTimeout(() => resolve(NodeStatus.RUNNING), 5));
          }
          return NodeStatus.RUNNING;
        },
      }),
    });

    const actor1 = new TreeActor({ createTree, stateStore: store, stateKey: 'default' });
    const result1 = await actor1.process({ type: 'tick' });
    expect(result1.treeStatus).toBe(NodeStatus.RUNNING);
    const saved1 = await store.getState('default');
    expect(saved1!.sessions).toEqual({ triage: 'session-xyz' });

    // Second process: replace state with a SUCCESS-returning tree
    // using the same node name so rootHash matches, but inject sessions
    // from the saved state. The tree returns SUCCESS, which clears sessions.
    await store.saveState('default', { ...saved1!, sessions: { triage: 'session-xyz' } });

    const actorSuccess = new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({ name: 'action', action: async () => NodeStatus.SUCCESS }),
      }),
      stateStore: store,
      stateKey: 'default',
    });

    const result2 = await actorSuccess.process({ type: 'tick' });
    expect(result2.treeStatus).toBe(NodeStatus.SUCCESS);
    const saved2 = await store.getState('default');
    expect(saved2!.sessions).toEqual({});
  });
});
