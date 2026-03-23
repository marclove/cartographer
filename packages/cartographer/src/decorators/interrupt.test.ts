import { describe, it, expect } from 'vitest';
import { TimeoutNode } from './timeout.js';
import { RetryNode } from './retry.js';
import { RepeatNode } from './repeat.js';
import { InverterNode } from './inverter.js';
import { GuardNode } from './guard.js';
import { AlwaysSucceedNode } from './always-succeed.js';
import { AlwaysFailNode } from './always-fail.js';
import { UntilSuccessNode } from './until-success.js';
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

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('TimeoutNode.interrupt()', () => {
  it('clears timer and start time so next activation gets fresh timeout', async () => {
    let resolveChild: (status: NodeStatus) => void;
    const child = new ActionNode({
      name: 'slow-child',
      action: () => new Promise<NodeStatus>((r) => { resolveChild = r; }),
    });

    const timeout = new TimeoutNode({
      name: 'test-timeout',
      child,
      timeoutMs: 5000,
    });
    const ctx = createContext();

    // Tick 1: child starts, returns RUNNING, timeout timer starts
    await timeout.tick(ctx);
    expect(child.hasInflightWork()).toBe(true);

    // Interrupt: should clear timer and child's inflight
    timeout.interrupt();
    expect(child.hasInflightWork()).toBe(false);

    // Tick after interrupt: timeout window should reset (fresh start)
    // Child restarts with a new invocation
    const status = await timeout.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);

    // Cleanup
    resolveChild!(NodeStatus.SUCCESS);
  });

  it('preserves child state through interrupt (no reset)', async () => {
    // Timeout interrupt should NOT call child.reset(), only child.interrupt()
    let resolveChild: (status: NodeStatus) => void;
    const child = new ActionNode({
      name: 'child',
      action: () => new Promise<NodeStatus>((r) => { resolveChild = r; }),
    });

    const timeout = new TimeoutNode({
      name: 'test-timeout',
      child,
      timeoutMs: 10000,
    });
    const ctx = createContext();

    await timeout.tick(ctx);
    timeout.interrupt();

    // Tree is tickable immediately (no reset needed)
    const status = await timeout.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);

    resolveChild!(NodeStatus.SUCCESS);
  });
});

describe('RetryNode.interrupt()', () => {
  it('preserves attempt count across interrupt', async () => {
    let callCount = 0;
    let resolveChild: (status: NodeStatus) => void;

    const child = new ActionNode({
      name: 'flaky',
      action: () => {
        callCount++;
        if (callCount <= 2) return NodeStatus.FAILURE; // attempts 1 and 2 fail
        return new Promise<NodeStatus>((r) => { resolveChild = r; });
      },
    });

    const retry = new RetryNode({
      name: 'test-retry',
      child,
      maxAttempts: 5,
    });
    const ctx = createContext();

    // Tick 1: child starts (callCount=1), returns RUNNING (inflight pattern)
    await retry.tick(ctx);
    expect(callCount).toBe(1);
    await flush();

    // Tick 2: child collects FAILURE, retry increments, starts attempt 2
    await retry.tick(ctx);
    expect(callCount).toBe(2);
    await flush();

    // Tick 3: child collects FAILURE, retry increments, starts attempt 3 (async)
    await retry.tick(ctx);
    expect(callCount).toBe(3);

    // Interrupt during attempt 3
    retry.interrupt();
    expect(child.hasInflightWork()).toBe(false);

    // Cleanup
    resolveChild!(NodeStatus.SUCCESS);
  });
});

describe('RepeatNode.interrupt()', () => {
  it('preserves iteration count across interrupt', async () => {
    let callCount = 0;
    let resolveChild: (status: NodeStatus) => void;

    const child = new ActionNode({
      name: 'repeating',
      action: () => {
        callCount++;
        if (callCount <= 2) return NodeStatus.SUCCESS;
        return new Promise<NodeStatus>((r) => { resolveChild = r; });
      },
    });

    const repeat = new RepeatNode({
      name: 'test-repeat',
      child,
      count: 5,
    });
    const ctx = createContext();

    // Tick 1: child starts (callCount=1), returns RUNNING
    await repeat.tick(ctx);
    expect(callCount).toBe(1);
    await flush();

    // Tick 2: child collects SUCCESS, repeat increments, starts child again
    await repeat.tick(ctx);
    expect(callCount).toBe(2);
    await flush();

    // Tick 3: child collects SUCCESS, repeat increments, starts child (async)
    await repeat.tick(ctx);
    expect(callCount).toBe(3);

    // Interrupt during async iteration
    repeat.interrupt();
    expect(child.hasInflightWork()).toBe(false);

    // Cleanup
    resolveChild!(NodeStatus.SUCCESS);
  });
});

describe('simple decorator interrupt()', () => {
  it('InverterNode delegates to child.interrupt()', async () => {
    let resolveChild: (status: NodeStatus) => void;
    const child = new ActionNode({
      name: 'child',
      action: () => new Promise<NodeStatus>((r) => { resolveChild = r; }),
    });
    const inverter = new InverterNode({ name: 'inv', child });
    const ctx = createContext();

    await inverter.tick(ctx);
    expect(child.hasInflightWork()).toBe(true);
    inverter.interrupt();
    expect(child.hasInflightWork()).toBe(false);
    resolveChild!(NodeStatus.SUCCESS);
  });

  it('GuardNode delegates to child.interrupt()', async () => {
    let resolveChild: (status: NodeStatus) => void;
    const child = new ActionNode({
      name: 'child',
      action: () => new Promise<NodeStatus>((r) => { resolveChild = r; }),
    });
    const guard = new GuardNode({ name: 'g', child, condition: () => true });
    const ctx = createContext();

    await guard.tick(ctx);
    await flush();
    await guard.tick(ctx); // condition passes, child starts
    expect(child.hasInflightWork()).toBe(true);
    guard.interrupt();
    expect(child.hasInflightWork()).toBe(false);
    resolveChild!(NodeStatus.SUCCESS);
  });

  it('AlwaysSucceedNode delegates to child.interrupt()', async () => {
    let resolveChild: (status: NodeStatus) => void;
    const child = new ActionNode({
      name: 'child',
      action: () => new Promise<NodeStatus>((r) => { resolveChild = r; }),
    });
    const node = new AlwaysSucceedNode({ name: 'as', child });
    const ctx = createContext();

    await node.tick(ctx);
    expect(child.hasInflightWork()).toBe(true);
    node.interrupt();
    expect(child.hasInflightWork()).toBe(false);
    resolveChild!(NodeStatus.SUCCESS);
  });

  it('AlwaysFailNode delegates to child.interrupt()', async () => {
    let resolveChild: (status: NodeStatus) => void;
    const child = new ActionNode({
      name: 'child',
      action: () => new Promise<NodeStatus>((r) => { resolveChild = r; }),
    });
    const node = new AlwaysFailNode({ name: 'af', child });
    const ctx = createContext();

    await node.tick(ctx);
    expect(child.hasInflightWork()).toBe(true);
    node.interrupt();
    expect(child.hasInflightWork()).toBe(false);
    resolveChild!(NodeStatus.SUCCESS);
  });

  it('UntilSuccessNode delegates to child.interrupt()', async () => {
    let resolveChild: (status: NodeStatus) => void;
    const child = new ActionNode({
      name: 'child',
      action: () => new Promise<NodeStatus>((r) => { resolveChild = r; }),
    });
    const node = new UntilSuccessNode({ name: 'us', child });
    const ctx = createContext();

    await node.tick(ctx);
    expect(child.hasInflightWork()).toBe(true);
    node.interrupt();
    expect(child.hasInflightWork()).toBe(false);
    resolveChild!(NodeStatus.SUCCESS);
  });
});
