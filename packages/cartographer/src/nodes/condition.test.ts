import { describe, it, expect, vi } from 'vitest';
import { ConditionNode } from './condition.js';
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

describe('ConditionNode', () => {
  it('returns SUCCESS when condition is true', async () => {
    const node = new ConditionNode({ name: 'true-cond', condition: () => true });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns FAILURE when condition is false', async () => {
    const node = new ConditionNode({ name: 'false-cond', condition: () => false });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('supports async conditions', async () => {
    const node = new ConditionNode({ name: 'async-cond', condition: async () => true });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('passes TreeContext to the condition', async () => {
    const condFn = vi.fn(() => true);
    const node = new ConditionNode({ name: 'ctx-cond', condition: condFn });
    const ctx = createContext();
    await node.tick(ctx);
    expect(condFn).toHaveBeenCalledWith(ctx);
  });

  it('returns FAILURE when condition throws', async () => {
    const node = new ConditionNode({
      name: 'error-cond',
      condition: () => {
        throw new Error('boom');
      },
    });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('reads from blackboard in condition', async () => {
    const node = new ConditionNode({
      name: 'bb-cond',
      condition: (ctx) => ctx.blackboard.get<number>('health')! > 50,
    });
    const ctx = createContext();
    ctx.blackboard.set('health', 80);
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
    ctx.blackboard.set('health', 20);
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
  });
});
