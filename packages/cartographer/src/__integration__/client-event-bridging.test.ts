import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { notify } from '../nodes/notify.js';
import { NodeStatus } from '../types.js';
import { setupTest, waitForEvent } from './helpers.js';

describe('client:event SSE bridging', () => {
  it('notify events arrive via SSE', async () => {
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
              notify('ui:message', (ctx) => ({
                text: ctx.blackboard.get('greeting'),
              })),
            ],
          }),
        }),
    });

    const eventsPromise = waitForEvent(harness.client, 'ui:message', 1);

    // NOTE: treeStatus is 'running' here — the runToCompletion heuristic
    // exits early when two consecutive sync actions both settle before
    // hasInflightWork() is checked. All work IS complete; see runToCompletion
    // in tree-actor.ts for context.
    await harness.client.commandAndWait('tick');

    const receivedEvents = await eventsPromise;
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]).toEqual({ text: 'hello world' });
  });

  it('multiple notify events arrive in order', async () => {
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

    const eventsPromise = waitForEvent(harness.client, 'ui:step', 3);

    const result = await harness.client.commandAndWait('tick');
    expect(result.treeStatus).toBe('success');

    const receivedEvents = await eventsPromise;
    expect(receivedEvents).toHaveLength(3);
    expect(receivedEvents).toEqual([{ step: 1 }, { step: 2 }, { step: 3 }]);
  });

  it('notify also writes to blackboard (dual write)', async () => {
    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'dual-write',
          root: notify('ui:status', () => ({ ready: true })),
        }),
    });

    await harness.client.commandAndWait('tick');
    const bb = await harness.client.blackboard();
    expect(bb['clientEvents:ui:status']).toEqual({ ready: true });
  });
});
