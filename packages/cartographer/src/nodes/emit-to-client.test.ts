import { describe, it, expect } from 'vitest';
import { emitToClient } from './emit-to-client.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('EmitToClientNode', () => {
  it('writes payload to blackboard under clientEvents: namespace', async () => {
    const node = emitToClient('ui:show_review', () => ({ findings: 'some data' }));
    const ctx = createContext();

    await node.tick(ctx); // starts inflight
    await flush();
    await node.tick(ctx); // collects result

    expect(ctx.blackboard.get('clientEvents:ui:show_review')).toEqual({ findings: 'some data' });
  });

  it('emits client:event through the event system', async () => {
    const node = emitToClient('ui:show_review', () => ({ findings: 'data' }));
    const ctx = createContext();
    const events: Array<{ name: string; data: unknown }> = [];
    ctx.events.on('client:event', (e) => events.push(e));

    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ name: 'ui:show_review', data: { findings: 'data' } });
  });

  it('returns SUCCESS after emitting', async () => {
    const node = emitToClient('test', () => ({}));
    const ctx = createContext();

    await node.tick(ctx);
    await flush();
    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.SUCCESS);
  });

  it('receives TreeContext in the data function', async () => {
    const node = emitToClient('test', (ctx) => ({
      value: ctx.blackboard.get('some:key'),
    }));
    const ctx = createContext();
    ctx.blackboard.set('some:key', 42);

    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(ctx.blackboard.get('clientEvents:test')).toEqual({ value: 42 });
  });

  it('produces stable content hash', () => {
    const a = emitToClient('ui:review', () => ({}));
    const b = emitToClient('ui:review', () => ({}));
    expect(a.contentHash()).toBe(b.contentHash());
  });
});
