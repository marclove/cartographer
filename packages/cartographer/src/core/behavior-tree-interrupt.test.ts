import { describe, it, expect, vi } from 'vitest';
import { BehaviorTree } from './behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { SessionRegistry } from './session-registry.js';
import { NodeStatus } from '../types.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('BehaviorTree.interrupt()', () => {
  it('cancels in-flight work and emits tree:interrupt', async () => {
    let resolveChild: (status: NodeStatus) => void;
    const child = new ActionNode({
      name: 'slow',
      action: () => new Promise<NodeStatus>((r) => { resolveChild = r; }),
    });

    const tree = new BehaviorTree({ name: 'test', root: child });
    const interruptSpy = vi.fn();
    tree.events.on('tree:interrupt', interruptSpy);

    // Start work
    await tree.tick();
    expect(tree.hasInflightWork()).toBe(true);

    // Interrupt
    tree.interrupt();
    expect(tree.hasInflightWork()).toBe(false);
    expect(interruptSpy).toHaveBeenCalledWith({ tree: 'test' });

    // Cleanup
    resolveChild!(NodeStatus.SUCCESS);
  });

  it('does NOT trigger the AbortController — tree remains tickable', async () => {
    let resolveChild: (status: NodeStatus) => void;
    const child = new ActionNode({
      name: 'slow',
      action: () => new Promise<NodeStatus>((r) => { resolveChild = r; }),
    });

    const tree = new BehaviorTree({ name: 'test', root: child });

    // Start work
    await tree.tick();
    tree.interrupt();

    // Tree is immediately tickable — no reset() needed
    const status = await tree.tick();
    expect(status).toBe(NodeStatus.RUNNING); // child restarts

    // Cleanup
    resolveChild!(NodeStatus.SUCCESS);
  });

  it('preserves sequence completedMap across interrupt', async () => {
    let callCountA = 0;
    let resolveB: (status: NodeStatus) => void;

    const childA = new ActionNode({
      name: 'a',
      action: () => { callCountA++; return NodeStatus.SUCCESS; },
    });
    const childB = new ActionNode({
      name: 'b',
      action: () => new Promise<NodeStatus>((r) => { resolveB = r; }),
    });

    const seq = new SequenceNode({ name: 'seq', children: [childA, childB] });
    const tree = new BehaviorTree({ name: 'test', root: seq });

    // Tick 1: A succeeds (cached), B starts
    await tree.tick();
    await flush();
    // Tick 2: A cached, B RUNNING
    await tree.tick();
    expect(callCountA).toBe(1);

    // Interrupt
    tree.interrupt();

    // Tick 3: A should still be cached, B restarts
    const status = await tree.tick();
    expect(status).toBe(NodeStatus.RUNNING);
    expect(callCountA).toBe(1); // A was NOT re-executed

    // Cleanup
    resolveB!(NodeStatus.SUCCESS);
  });

  it('preserves SessionRegistry across interrupt', async () => {
    let resolveChild: (status: NodeStatus) => void;
    const child = new ActionNode({
      name: 'slow',
      action: () => new Promise<NodeStatus>((r) => { resolveChild = r; }),
    });

    const sessionRegistry = new SessionRegistry();
    sessionRegistry.set('triage', 'sdk-session-abc');
    sessionRegistry.set('research', 'sdk-session-def');

    const tree = new BehaviorTree({ name: 'test', root: child, sessionRegistry });

    // Start work
    await tree.tick();
    expect(tree.hasInflightWork()).toBe(true);

    // Interrupt — sessions must survive
    tree.interrupt();
    expect(tree.sessionRegistry.has('triage')).toBe(true);
    expect(tree.sessionRegistry.get('triage')).toBe('sdk-session-abc');
    expect(tree.sessionRegistry.has('research')).toBe(true);
    expect(tree.sessionRegistry.get('research')).toBe('sdk-session-def');

    // Cleanup
    resolveChild!(NodeStatus.SUCCESS);
  });

  it('is a no-op when no work is in flight', () => {
    const child = new ActionNode({
      name: 'idle',
      action: () => NodeStatus.SUCCESS,
    });
    const tree = new BehaviorTree({ name: 'test', root: child });

    // Should not throw
    tree.interrupt();
    expect(tree.hasInflightWork()).toBe(false);
  });
});
