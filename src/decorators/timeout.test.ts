import { describe, it, expect, vi } from 'vitest';
import { TimeoutNode } from './timeout.js';
import { ActionNode } from '../nodes/action.js';
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
    id: 'child', name: 'child', children: [],
    tick: vi.fn(async () => status),
    reset: vi.fn(), abort: vi.fn(),
  };
}

function slowChild(delayMs = 200): BTreeNode {
  return {
    id: 'slow', name: 'slow-child', children: [],
    tick: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return NodeStatus.SUCCESS;
    },
    reset: () => {}, abort: vi.fn(),
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
    const child = slowChild();
    const node = new TimeoutNode({ name: 'to', child, timeoutMs: 50 });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('calls abort on child when timeout fires', async () => {
    const child = slowChild();
    const node = new TimeoutNode({ name: 'to', child, timeoutMs: 50 });
    await node.tick(createContext());
    expect(child.abort).toHaveBeenCalledOnce();
  });

  it('emits child node:exit before timeout node:exit on abort', async () => {
    const ctx = createContext();
    const exits: string[] = [];
    ctx.events.on('node:exit', ({ node }) => exits.push(node.name));

    const child = new ActionNode({
      name: 'slow-action',
      action: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return NodeStatus.SUCCESS;
      },
    });
    const node = new TimeoutNode({ name: 'timeout-parent', child, timeoutMs: 50 });
    await node.tick(ctx);

    expect(exits).toEqual(['slow-action', 'timeout-parent']);
  });
});
