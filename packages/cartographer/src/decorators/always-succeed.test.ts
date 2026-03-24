import { describe, it, expect, vi } from 'vitest';
import { AlwaysSucceedNode } from './always-succeed.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';
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

function mockChild(status: NodeStatus): BTreeNode {
  return {
    id: 'child', name: 'child',
    tick: vi.fn(async () => status),
    reset: vi.fn(), abort: vi.fn(),
  };
}

describe('AlwaysSucceedNode', () => {
  it('returns SUCCESS when child succeeds', async () => {
    const node = new AlwaysSucceedNode({ name: 'as', child: mockChild(NodeStatus.SUCCESS) });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns SUCCESS when child fails', async () => {
    const node = new AlwaysSucceedNode({ name: 'as', child: mockChild(NodeStatus.FAILURE) });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns RUNNING when child returns RUNNING', async () => {
    const node = new AlwaysSucceedNode({ name: 'as', child: mockChild(NodeStatus.RUNNING) });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });
});
