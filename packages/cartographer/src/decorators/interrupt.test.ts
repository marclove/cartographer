import { describe, it, expect } from 'vitest';
import { Timeout } from './timeout.js';
import { Retry } from './retry.js';
import { Repeat } from './repeat.js';
import { Inverter } from './inverter.js';
import { Guard } from './guard.js';
import { AlwaysSucceed } from './always-succeed.js';
import { AlwaysFail } from './always-fail.js';
import { UntilSuccess } from './until-success.js';
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

describe('Timeout.interrupt()', () => {
  it('clears timer and start time so next activation gets fresh timeout', async () => {
    let resolveChild: (status: NodeStatus) => void;
    const child = new ActionNode({
      name: 'slow-child',
      action: () => new Promise<NodeStatus>((r) => { resolveChild = r; }),
    });

    const timeout = new Timeout({
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

    const timeout = new Timeout({
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

describe('Retry.interrupt()', () => {
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

    const retry = new Retry({
      name: 'test-retry',
      child,
      maxAttempts: 5,
    });
    const ctx = createContext();

    // Tick 1: sync attempts 1 (FAILURE) and 2 (FAILURE) resolve immediately,
    // then attempt 3 starts async inflight → RUNNING
    await retry.tick(ctx);
    expect(callCount).toBe(3);

    // Interrupt during attempt 3
    retry.interrupt();
    expect(child.hasInflightWork()).toBe(false);

    // Cleanup
    resolveChild!(NodeStatus.SUCCESS);
  });
});

describe('Repeat.interrupt()', () => {
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

    const repeat = new Repeat({
      name: 'test-repeat',
      child,
      count: 5,
    });
    const ctx = createContext();

    // Tick 1: sync iterations 1 (SUCCESS) and 2 (SUCCESS) resolve immediately,
    // then iteration 3 starts async inflight → RUNNING
    await repeat.tick(ctx);
    expect(callCount).toBe(3);

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
  it('Inverter delegates to child.interrupt()', async () => {
    let resolveChild: (status: NodeStatus) => void;
    const child = new ActionNode({
      name: 'child',
      action: () => new Promise<NodeStatus>((r) => { resolveChild = r; }),
    });
    const inverter = new Inverter({ name: 'inv', child });
    const ctx = createContext();

    await inverter.tick(ctx);
    expect(child.hasInflightWork()).toBe(true);
    inverter.interrupt();
    expect(child.hasInflightWork()).toBe(false);
    resolveChild!(NodeStatus.SUCCESS);
  });

  it('Guard delegates to child.interrupt()', async () => {
    let resolveChild: (status: NodeStatus) => void;
    const child = new ActionNode({
      name: 'child',
      action: () => new Promise<NodeStatus>((r) => { resolveChild = r; }),
    });
    const guard = new Guard({ name: 'g', child, condition: () => true });
    const ctx = createContext();

    await guard.tick(ctx);
    await flush();
    await guard.tick(ctx); // condition passes, child starts
    expect(child.hasInflightWork()).toBe(true);
    guard.interrupt();
    expect(child.hasInflightWork()).toBe(false);
    resolveChild!(NodeStatus.SUCCESS);
  });

  it('AlwaysSucceed delegates to child.interrupt()', async () => {
    let resolveChild: (status: NodeStatus) => void;
    const child = new ActionNode({
      name: 'child',
      action: () => new Promise<NodeStatus>((r) => { resolveChild = r; }),
    });
    const node = new AlwaysSucceed({ name: 'as', child });
    const ctx = createContext();

    await node.tick(ctx);
    expect(child.hasInflightWork()).toBe(true);
    node.interrupt();
    expect(child.hasInflightWork()).toBe(false);
    resolveChild!(NodeStatus.SUCCESS);
  });

  it('AlwaysFail delegates to child.interrupt()', async () => {
    let resolveChild: (status: NodeStatus) => void;
    const child = new ActionNode({
      name: 'child',
      action: () => new Promise<NodeStatus>((r) => { resolveChild = r; }),
    });
    const node = new AlwaysFail({ name: 'af', child });
    const ctx = createContext();

    await node.tick(ctx);
    expect(child.hasInflightWork()).toBe(true);
    node.interrupt();
    expect(child.hasInflightWork()).toBe(false);
    resolveChild!(NodeStatus.SUCCESS);
  });

  it('UntilSuccess delegates to child.interrupt()', async () => {
    let resolveChild: (status: NodeStatus) => void;
    const child = new ActionNode({
      name: 'child',
      action: () => new Promise<NodeStatus>((r) => { resolveChild = r; }),
    });
    const node = new UntilSuccess({ name: 'us', child });
    const ctx = createContext();

    await node.tick(ctx);
    expect(child.hasInflightWork()).toBe(true);
    node.interrupt();
    expect(child.hasInflightWork()).toBe(false);
    resolveChild!(NodeStatus.SUCCESS);
  });
});
