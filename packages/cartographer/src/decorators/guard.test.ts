import { describe, it, expect, vi } from 'vitest';
import { Guard } from './guard.js';
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

describe('Guard', () => {
  it('ticks child when condition is true', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new Guard({ name: 'guard', child, condition: () => true });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalled();
  });

  it('returns FAILURE without ticking child when condition is false', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new Guard({ name: 'guard', child, condition: () => false });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
    expect(child.tick).not.toHaveBeenCalled();
  });

  it('supports async conditions (inflight pattern)', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new Guard({ name: 'guard', child, condition: async () => true });
    const ctx = createContext();
    // Tick 1: async condition starts, returns RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await new Promise<void>((r) => setTimeout(r, 0));
    // Tick 2: condition resolved true, child ticked
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('caches child terminal status while condition remains true', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new Guard({ name: 'guard', child, condition: () => true });
    const ctx = createContext();

    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(1);

    // Second tick should reuse cached result, not retick child
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(1);
  });

  it('clears cache when condition flips false, allowing re-run', async () => {
    let allow = true;
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new Guard({ name: 'guard', child, condition: () => allow });
    const ctx = createContext();

    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(1);

    allow = false;
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);

    allow = true;
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(2);
  });

  it('returns FAILURE when condition throws', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new Guard({
      name: 'guard', child,
      condition: () => { throw new Error('boom'); },
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
    expect(child.tick).not.toHaveBeenCalled();
  });
});

describe('Guard async condition inflight', () => {
  it('returns RUNNING while async condition is pending', async () => {
    let resolveCondition!: (v: boolean) => void;
    const condition = () => new Promise<boolean>((r) => { resolveCondition = r; });
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new Guard({ name: 'guard', child, condition });
    const ctx = createContext();

    // Tick 1: condition is pending → RUNNING, child not ticked
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(child.tick).not.toHaveBeenCalled();

    // Resolve condition to true
    resolveCondition(true);
    await new Promise<void>((r) => setTimeout(r, 0));

    // Tick 2: condition resolved true → tick child
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledOnce();
  });

  it('returns FAILURE when async condition resolves to false', async () => {
    let resolveCondition!: (v: boolean) => void;
    const condition = () => new Promise<boolean>((r) => { resolveCondition = r; });
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new Guard({ name: 'guard', child, condition });
    const ctx = createContext();

    // Tick 1: condition pending → RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);

    // Resolve condition to false
    resolveCondition(false);
    await new Promise<void>((r) => setTimeout(r, 0));

    // Tick 2: condition resolved false → FAILURE, child aborted
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
    expect(child.tick).not.toHaveBeenCalled();
    expect(child.abort).toHaveBeenCalledOnce();
  });

  it('returns FAILURE when async condition rejects', async () => {
    let rejectCondition!: (e: Error) => void;
    const condition = () => new Promise<boolean>((_, r) => { rejectCondition = r; });
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new Guard({ name: 'guard', child, condition });
    const ctx = createContext();

    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);

    rejectCondition(new Error('boom'));
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
    expect(child.abort).toHaveBeenCalledOnce();
  });

  it('abort() clears pending condition inflight state', async () => {
    let resolveCondition!: (v: boolean) => void;
    const condition = vi.fn(() => new Promise<boolean>((r) => { resolveCondition = r; }));
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new Guard({ name: 'guard', child, condition });
    const ctx = createContext();

    // Tick 1: condition pending
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(condition).toHaveBeenCalledTimes(1);

    // Abort clears inflight state
    node.abort();

    // Tick 2: fresh condition call, not polling the old one
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(condition).toHaveBeenCalledTimes(2);
  });

  it('reset() clears pending condition inflight state', async () => {
    let resolveCondition!: (v: boolean) => void;
    const condition = vi.fn(() => new Promise<boolean>((r) => { resolveCondition = r; }));
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new Guard({ name: 'guard', child, condition });
    const ctx = createContext();

    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(condition).toHaveBeenCalledTimes(1);

    node.reset();

    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(condition).toHaveBeenCalledTimes(2);
  });

  it('synchronous conditions still work without inflight overhead', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new Guard({ name: 'guard', child, condition: () => true });
    // Synchronous condition resolves in a single tick
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledOnce();
  });
});

describe('Guard abort on condition failure', () => {
  it('aborts child when condition returns false', async () => {
    const child = mockChild(NodeStatus.RUNNING);
    const node = new Guard({ name: 'guard', child, condition: () => false });
    await node.tick(createContext());
    expect(child.abort).toHaveBeenCalledOnce();
  });

  it('aborts child when condition throws', async () => {
    const child = mockChild(NodeStatus.RUNNING);
    const node = new Guard({
      name: 'guard', child,
      condition: () => { throw new Error('boom'); },
    });
    await node.tick(createContext());
    expect(child.abort).toHaveBeenCalledOnce();
  });

  it('does not abort child when condition passes', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new Guard({ name: 'guard', child, condition: () => true });
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
    const node = new Guard({ name: 'guard', child, condition: () => false });
    const result = await node.tick(createContext());
    expect(result).toBe(NodeStatus.FAILURE);
    expect(child.abort).toHaveBeenCalledOnce();
  });
});
