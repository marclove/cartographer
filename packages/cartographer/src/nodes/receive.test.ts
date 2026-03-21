import { describe, it, expect } from 'vitest';
import { receive } from './receive.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';
import { isReactiveNode } from '../composites/is-reactive-node.js';

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

describe('ReceiveNode', () => {
  it('returns SUCCESS and consumes key when action is present', async () => {
    const node = receive('approve');
    const ctx = createContext();
    ctx.blackboard.set('commands:approve', { docId: '123' });

    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.SUCCESS);
    expect(ctx.blackboard.get('commands:approve')).toBeUndefined();
  });

  it('returns FAILURE when action is not present', async () => {
    const node = receive('approve');
    const ctx = createContext();

    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.FAILURE);
  });

  it('is not reactive (isReactiveNode returns false)', () => {
    const node = receive('approve');
    expect(isReactiveNode(node)).toBe(false);
  });

  it('has no inflight work after tick', async () => {
    const node = receive('approve');
    const ctx = createContext();
    await node.tick(ctx);
    expect(node.hasInflightWork()).toBe(false);
  });

  it('calls mapPayload when action is present', async () => {
    const node = receive('approve', {
      mapPayload: (payload: any, blackboard) => {
        blackboard.set('review:decision', payload.decision);
      },
    });
    const ctx = createContext();
    ctx.blackboard.set('commands:approve', { decision: 'accepted' });

    await node.tick(ctx);
    expect(ctx.blackboard.get('review:decision')).toBe('accepted');
  });

  it('does not call mapPayload when action is absent', async () => {
    let called = false;
    const node = receive('approve', {
      mapPayload: () => { called = true; },
    });
    const ctx = createContext();
    await node.tick(ctx);
    expect(called).toBe(false);
  });

  it('produces stable content hash', () => {
    const a = receive('approve');
    const b = receive('approve');
    expect(a.contentHash()).toBe(b.contentHash());
  });

  it('produces different hash for different action names', () => {
    const a = receive('approve');
    const b = receive('reject');
    expect(a.contentHash()).not.toBe(b.contentHash());
  });
});
