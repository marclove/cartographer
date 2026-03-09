import { describe, it, expect, vi } from 'vitest';
import { TimeoutNode } from './timeout.js';
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

describe('TimeoutNode', () => {
  it('returns child status when child completes within timeout', async () => {
    const node = new TimeoutNode({
      name: 'to',
      child: mockChild(NodeStatus.SUCCESS),
      timeoutMs: 1000,
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns FAILURE when child exceeds timeout', async () => {
    const slowChild: BTreeNode = {
      id: 'slow', name: 'slow',
      tick: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return NodeStatus.SUCCESS;
      },
      reset: () => {}, abort: vi.fn(),
    };
    const node = new TimeoutNode({ name: 'to', child: slowChild, timeoutMs: 50 });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });
});
