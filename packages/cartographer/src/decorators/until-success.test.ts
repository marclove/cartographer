import { describe, it, expect } from 'vitest';
import { untilSuccess } from './until-success.js';
import { ActionNode } from '../nodes/action.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import { SessionRegistry } from '../core/session-registry.js';
import type { TreeEvents } from '../types.js';

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
    sessions: new SessionRegistry(),
  };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('UntilSuccess', () => {
  it('returns SUCCESS when child succeeds', async () => {
    const child = new ActionNode({ name: 'ok', action: async () => NodeStatus.SUCCESS });
    const node = untilSuccess(child);
    const ctx = createContext();

    await node.tick(ctx); // child starts → RUNNING
    await flush();
    const status = await node.tick(ctx); // child SUCCESS → pass through
    expect(status).toBe(NodeStatus.SUCCESS);
  });

  it('returns RUNNING when child fails (suspension point)', async () => {
    const child = new ActionNode({ name: 'fail', action: async () => NodeStatus.FAILURE });
    const node = untilSuccess(child);
    const ctx = createContext();

    await node.tick(ctx); // child starts → RUNNING
    await flush();
    const status = await node.tick(ctx); // child FAILURE → RUNNING
    expect(status).toBe(NodeStatus.RUNNING);
  });

  it('passes through RUNNING from child (in-flight work)', async () => {
    let resolve: (s: NodeStatus) => void;
    const child = new ActionNode({
      name: 'slow',
      action: () => new Promise<NodeStatus>(r => { resolve = r; }),
    });
    const node = untilSuccess(child);
    const ctx = createContext();

    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);
    resolve!(NodeStatus.SUCCESS);
  });

  it('has no in-flight work when suspended (child failed)', async () => {
    const child = new ActionNode({ name: 'fail', action: async () => NodeStatus.FAILURE });
    const node = untilSuccess(child);
    const ctx = createContext();

    await node.tick(ctx);
    await flush();
    await node.tick(ctx); // RUNNING (suspension)

    expect(node.hasInflightWork()).toBe(false);
  });
});
