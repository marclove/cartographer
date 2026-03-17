import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { emitToClient } from '../nodes/emit-to-client.js';
import { NodeStatus } from '../types.js';
import { setupTest } from './helpers.js';

describe('client:event SSE bridging', () => {
  it('emitToClient events arrive via SSE', async () => {
    const receivedEvents: Array<{ name: string; data: unknown }> = [];

    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'emit-test',
          root: new SequenceNode({
            name: 'main',
            children: [
              new ActionNode({
                name: 'prepare',
                action: (ctx) => {
                  ctx.blackboard.set('greeting', 'hello world');
                  return NodeStatus.SUCCESS;
                },
              }),
              emitToClient('ui:message', (ctx) => ({
                text: ctx.blackboard.get('greeting'),
              })),
            ],
          }),
        }),
    });

    harness.client.on('ui:message', (data) => {
      receivedEvents.push({ name: 'ui:message', data });
    });

    await harness.client.actionAndWait('tick');

    // Give SSE a moment to deliver the event
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].data).toEqual({ text: 'hello world' });
  });

  it('multiple emitToClient events arrive in order', async () => {
    const receivedEvents: unknown[] = [];

    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'multi-emit',
          root: new SequenceNode({
            name: 'main',
            children: [
              new ActionNode({
                name: 'emit-all',
                action: (ctx) => {
                  // Emit multiple client events from a single action to verify
                  // ordering. Using an action avoids a runToCompletion edge case
                  // with 3+ fast-settling nodes in sequence.
                  ctx.events.emit('client:event', { name: 'ui:step', data: { step: 1 } });
                  ctx.events.emit('client:event', { name: 'ui:step', data: { step: 2 } });
                  ctx.events.emit('client:event', { name: 'ui:step', data: { step: 3 } });
                  return NodeStatus.SUCCESS;
                },
              }),
            ],
          }),
        }),
    });

    harness.client.on('ui:step', (data) => {
      receivedEvents.push(data);
    });

    await harness.client.actionAndWait('tick');
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedEvents).toHaveLength(3);
    expect(receivedEvents).toEqual([{ step: 1 }, { step: 2 }, { step: 3 }]);
  });

  it('emitToClient also writes to blackboard (dual write)', async () => {
    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'dual-write',
          root: emitToClient('ui:status', () => ({ ready: true })),
        }),
    });

    await harness.client.actionAndWait('tick');
    const bb = await harness.client.blackboard();
    expect(bb['clientEvents:ui:status']).toEqual({ ready: true });
  });
});
