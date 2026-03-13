import { describe, it, expect, vi } from 'vitest';
import { RetryNode } from './retry.js';
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

function dynamicChild(statuses: NodeStatus[]): BTreeNode {
  let call = 0;
  return {
    id: 'child', name: 'child',
    tick: vi.fn(async () => statuses[call++] ?? NodeStatus.FAILURE),
    reset: vi.fn(), abort: vi.fn(),
  };
}

describe('RetryNode instance field persistence', () => {
  function createDeferredAction() {
    let resolve!: (status: NodeStatus) => void;
    const child: BTreeNode = {
      id: 'deferred', name: 'deferred',
      tick: vi.fn(async () => new Promise<NodeStatus>(r => { resolve = r; })),
      reset: vi.fn(), abort: vi.fn(),
    };
    return { child, resolve: (s: NodeStatus) => resolve(s) };
  }
  const flush = () => new Promise(r => setTimeout(r, 0));

  it('attempt counter persists across ticks when child returns RUNNING', async () => {
    // Child returns FAILURE, RUNNING (persists), then FAILURE, FAILURE => exhausted
    const child = dynamicChild([
      NodeStatus.FAILURE,  // attempt 0 fails
      NodeStatus.RUNNING,  // attempt 1 returns RUNNING
      NodeStatus.FAILURE,  // attempt 1 resumes, fails
      NodeStatus.FAILURE,  // attempt 2 fails => exhausted (maxAttempts=3)
    ]);
    const node = new RetryNode({ name: 'retry', child, maxAttempts: 3 });
    const ctx = createContext();

    // Tick 1: attempt 0 fails, attempt 1 returns RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(child.tick).toHaveBeenCalledTimes(2);

    // Tick 2: resumes at attempt 1 (child returns FAILURE), then attempt 2 also fails => exhausted
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
    expect(child.tick).toHaveBeenCalledTimes(4);
  });

  it('after child resolves from RUNNING, retry continues from correct attempt', async () => {
    // attempt 0: RUNNING then SUCCESS on resume => done
    const child = dynamicChild([
      NodeStatus.RUNNING,  // attempt 0 returns RUNNING
      NodeStatus.SUCCESS,  // attempt 0 resumes, succeeds
    ]);
    const node = new RetryNode({ name: 'retry', child, maxAttempts: 3 });
    const ctx = createContext();

    // Tick 1: attempt 0 returns RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    expect(child.tick).toHaveBeenCalledTimes(1);

    // Tick 2: attempt 0 resumes with SUCCESS
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(2);
  });

  it('reset() clears the attempt counter', async () => {
    const child = dynamicChild([
      NodeStatus.FAILURE,  // attempt 0 fails
      NodeStatus.RUNNING,  // attempt 1 returns RUNNING
      // after reset, counter is back to 0
      NodeStatus.FAILURE,  // attempt 0 fails
      NodeStatus.FAILURE,  // attempt 1 fails
      NodeStatus.FAILURE,  // attempt 2 fails => exhausted
    ]);
    const node = new RetryNode({ name: 'retry', child, maxAttempts: 3 });
    const ctx = createContext();

    // Tick 1: attempt 0 fails, attempt 1 returns RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);

    // Reset clears the counter
    node.reset();

    // Tick 2: starts from attempt 0 again
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
    expect(child.tick).toHaveBeenCalledTimes(5);
  });

  it('counter resets when all attempts exhausted', async () => {
    const child = dynamicChild([
      // First run: all attempts fail
      NodeStatus.FAILURE,
      NodeStatus.FAILURE,
      // Second run: should start from attempt 0 again
      NodeStatus.SUCCESS,
    ]);
    const node = new RetryNode({ name: 'retry', child, maxAttempts: 2 });
    const ctx = createContext();

    // All attempts exhausted
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);

    // Counter should have reset — next tick starts from attempt 0
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(3);
  });
});

describe('RetryNode', () => {
  it('returns SUCCESS on first try if child succeeds', async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new RetryNode({ name: 'retry', child, maxAttempts: 3 });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(1);
  });

  it('retries on FAILURE up to maxAttempts', async () => {
    const child = mockChild(NodeStatus.FAILURE);
    const node = new RetryNode({ name: 'retry', child, maxAttempts: 3 });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
    expect(child.tick).toHaveBeenCalledTimes(3);
  });

  it('succeeds if a retry succeeds', async () => {
    const child = dynamicChild([NodeStatus.FAILURE, NodeStatus.FAILURE, NodeStatus.SUCCESS]);
    const node = new RetryNode({ name: 'retry', child, maxAttempts: 5 });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(3);
  });

  it('returns RUNNING immediately without retry', async () => {
    const child = mockChild(NodeStatus.RUNNING);
    const node = new RetryNode({ name: 'retry', child, maxAttempts: 3 });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
    expect(child.tick).toHaveBeenCalledTimes(1);
  });

  it('delays between retries when delayMs is set', async () => {
    const child = dynamicChild([NodeStatus.FAILURE, NodeStatus.SUCCESS]);
    const node = new RetryNode({ name: 'retry', child, maxAttempts: 3, delayMs: 50 });
    const start = performance.now();
    await node.tick(createContext());
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});
