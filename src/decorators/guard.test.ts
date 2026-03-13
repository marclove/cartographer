import { describe, it, expect, vi } from 'vitest';
import { GuardNode } from './guard.js';
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

describe('GuardNode', () => {
  it('ticks child when condition is true', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new GuardNode({ name: 'guard', child, condition: () => true });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalled();
  });

  it('returns FAILURE without ticking child when condition is false', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new GuardNode({ name: 'guard', child, condition: () => false });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
    expect(child.tick).not.toHaveBeenCalled();
  });

  it('supports async conditions', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new GuardNode({ name: 'guard', child, condition: async () => true });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns FAILURE when condition throws', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new GuardNode({
      name: 'guard', child,
      condition: () => { throw new Error('boom'); },
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
    expect(child.tick).not.toHaveBeenCalled();
  });
});

describe('GuardNode abort on condition failure', () => {
  it('aborts child when condition returns false', async () => {
    const child = mockChild(NodeStatus.RUNNING);
    const node = new GuardNode({ name: 'guard', child, condition: () => false });
    await node.tick(createContext());
    expect(child.abort).toHaveBeenCalledOnce();
  });

  it('aborts child when condition throws', async () => {
    const child = mockChild(NodeStatus.RUNNING);
    const node = new GuardNode({
      name: 'guard', child,
      condition: () => { throw new Error('boom'); },
    });
    await node.tick(createContext());
    expect(child.abort).toHaveBeenCalledOnce();
  });

  it('does not abort child when condition passes', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new GuardNode({ name: 'guard', child, condition: () => true });
    await node.tick(createContext());
    expect(child.abort).not.toHaveBeenCalled();
  });

  it('abort is safe on child without inflight state', async () => {
    const child: BTreeNode = {
      id: 'simple', name: 'simple',
      tick: vi.fn(async () => NodeStatus.SUCCESS),
      reset: vi.fn(),
      abort: vi.fn(),
    };
    const node = new GuardNode({ name: 'guard', child, condition: () => false });
    const result = await node.tick(createContext());
    expect(result).toBe(NodeStatus.FAILURE);
    expect(child.abort).toHaveBeenCalledOnce();
  });
});
