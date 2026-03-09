import { describe, it, expect, vi } from 'vitest';
import { AlwaysFailNode } from './always-fail.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { MapBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';

function createContext(): TreeContext {
  return {
    blackboard: new MapBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

function mockChild(status: NodeStatus): BTreeNode {
  return {
    id: 'child', name: 'child',
    tick: vi.fn(async () => status),
    reset: vi.fn(), abort: vi.fn(),
  };
}

describe('AlwaysFailNode', () => {
  it('returns FAILURE when child succeeds', async () => {
    const node = new AlwaysFailNode({ name: 'af', child: mockChild(NodeStatus.SUCCESS) });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('returns FAILURE when child fails', async () => {
    const node = new AlwaysFailNode({ name: 'af', child: mockChild(NodeStatus.FAILURE) });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('returns RUNNING when child returns RUNNING', async () => {
    const node = new AlwaysFailNode({ name: 'af', child: mockChild(NodeStatus.RUNNING) });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });
});
