import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimeoutNode } from './timeout.js';
import { ActionNode } from '../nodes/action.js';
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
    id: 'child', name: 'child', children: [],
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
    vi.useFakeTimers();
    const child = mockChild(NodeStatus.RUNNING);
    const node = new TimeoutNode({ name: 'to', child, timeoutMs: 50 });
    const ctx = createContext();
    // First tick starts the timer
    await node.tick(ctx);
    // Advance past timeout
    await vi.advanceTimersByTimeAsync(100);
    // Second tick detects expiration
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
    vi.useRealTimers();
  });

  it('calls abort on child when timeout fires', async () => {
    vi.useFakeTimers();
    const child = mockChild(NodeStatus.RUNNING);
    const node = new TimeoutNode({ name: 'to', child, timeoutMs: 50 });
    const ctx = createContext();
    await node.tick(ctx);
    await vi.advanceTimersByTimeAsync(100);
    await node.tick(ctx);
    expect(child.abort).toHaveBeenCalledOnce();
    vi.useRealTimers();
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

describe('TimeoutNode wall-clock tracking', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns RUNNING while within timeout', async () => {
    const child = mockChild(NodeStatus.RUNNING);
    const node = new TimeoutNode({ name: 'to', child, timeoutMs: 1000 });
    const ctx = createContext();

    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);
  });

  it('returns FAILURE when timeout expires', async () => {
    const child = mockChild(NodeStatus.RUNNING);
    const node = new TimeoutNode({ name: 'to', child, timeoutMs: 500 });
    const ctx = createContext();

    // First tick — child returns RUNNING, starts timer
    await node.tick(ctx);

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(600);

    // Second tick — timeout has expired
    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.FAILURE);
  });

  it('aborts child on timeout', async () => {
    const child = mockChild(NodeStatus.RUNNING);
    const node = new TimeoutNode({ name: 'to', child, timeoutMs: 500 });
    const ctx = createContext();

    await node.tick(ctx);
    await vi.advanceTimersByTimeAsync(600);
    await node.tick(ctx);

    expect(child.abort).toHaveBeenCalledOnce();
  });

  it('returns child terminal status before timeout', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new TimeoutNode({ name: 'to', child, timeoutMs: 1000 });
    const ctx = createContext();

    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.SUCCESS);
  });

  it('starts timing from first RUNNING tick, not from construction', async () => {
    // Child returns SUCCESS on first tick, then RUNNING on subsequent ticks
    let tickCount = 0;
    const child: BTreeNode = {
      id: 'child', name: 'child', children: [],
      tick: vi.fn(async () => {
        tickCount++;
        return tickCount === 1 ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
      }),
      reset: vi.fn(), abort: vi.fn(),
    };
    const node = new TimeoutNode({ name: 'to', child, timeoutMs: 500 });
    const ctx = createContext();

    // First tick — child returns SUCCESS, no timer started
    await node.tick(ctx);

    // Advance time significantly
    await vi.advanceTimersByTimeAsync(1000);

    // Second tick — child returns RUNNING, timer starts NOW
    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);

    // Advance only 200ms — still within 500ms timeout from second tick
    await vi.advanceTimersByTimeAsync(200);
    const status2 = await node.tick(ctx);
    // Should still be RUNNING (child returns RUNNING), not timed out
    expect(status2).toBe(NodeStatus.RUNNING);
  });

  it('clears startTime on child completion so new cycle gets fresh timeout', async () => {
    // First cycle: child returns RUNNING then SUCCESS
    let returnRunning = true;
    const child: BTreeNode = {
      id: 'child', name: 'child', children: [],
      tick: vi.fn(async () => returnRunning ? NodeStatus.RUNNING : NodeStatus.SUCCESS),
      reset: vi.fn(), abort: vi.fn(),
    };
    const node = new TimeoutNode({ name: 'to', child, timeoutMs: 500 });
    const ctx = createContext();

    // Tick 1 — RUNNING, starts timer
    await node.tick(ctx);

    // Advance 300ms
    await vi.advanceTimersByTimeAsync(300);

    // Tick 2 — child completes, clears timer
    returnRunning = false;
    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.SUCCESS);

    // Start new cycle — advance 300ms more (total 600ms from first start)
    returnRunning = true;
    await vi.advanceTimersByTimeAsync(300);

    // Tick 3 — should NOT timeout, because startTime was cleared
    const status2 = await node.tick(ctx);
    expect(status2).toBe(NodeStatus.RUNNING);
  });

  it('reset() clears startTime', async () => {
    const child = mockChild(NodeStatus.RUNNING);
    const node = new TimeoutNode({ name: 'to', child, timeoutMs: 500 });
    const ctx = createContext();

    // Start timer
    await node.tick(ctx);

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(600);

    // Reset clears the timer
    node.reset();

    // Next tick should NOT timeout — fresh start
    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);
  });

  it('abort() clears startTime and aborts child', async () => {
    const child = mockChild(NodeStatus.RUNNING);
    const node = new TimeoutNode({ name: 'to', child, timeoutMs: 500 });
    const ctx = createContext();

    // Start timer
    await node.tick(ctx);

    // Abort
    node.abort();
    expect(child.abort).toHaveBeenCalledOnce();

    // Advance past original timeout
    await vi.advanceTimersByTimeAsync(600);

    // Next tick should NOT timeout — abort cleared the timer
    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);
  });
});
