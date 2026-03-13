import { describe, it, expect, vi } from 'vitest';
import { InverterNode } from './inverter.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
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

describe('InverterNode', () => {
  it('flips SUCCESS to FAILURE', async () => {
    const node = new InverterNode({ name: 'inv', child: mockChild(NodeStatus.SUCCESS) });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('flips FAILURE to SUCCESS', async () => {
    const node = new InverterNode({ name: 'inv', child: mockChild(NodeStatus.FAILURE) });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('passes RUNNING through unchanged', async () => {
    const node = new InverterNode({ name: 'inv', child: mockChild(NodeStatus.RUNNING) });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });

  it('delegates reset to child', () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new InverterNode({ name: 'inv', child });
    node.reset();
    expect(child.reset).toHaveBeenCalled();
  });
});
