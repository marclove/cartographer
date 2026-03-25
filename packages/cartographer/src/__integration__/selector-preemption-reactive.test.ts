import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { Guard } from '../decorators/guard.js';
import { emitToClient } from '../nodes/emit-to-client.js';
import { receive } from '../nodes/receive.js';
import { untilSuccess } from '../decorators/until-success.js';
import { NodeStatus } from '../types.js';
import { setupTest, waitForEvent, waitForBlackboard } from './helpers.js';

describe('selector preemption reactive', () => {
  it('reactive guard failure mid-deploy triggers rollback via selector fallback', async () => {
    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'deploy-pipeline',
          root: new SequenceNode({
            name: 'main',
            children: [
              // Plan the deployment
              new ActionNode({
                name: 'plan-deploy',
                action: (ctx) => {
                  ctx.blackboard.set('deploy-plan', { target: 'production', version: '2.1.0' });
                  return NodeStatus.SUCCESS;
                },
              }),

              // Execute or rollback
              new SelectorNode({
                name: 'execute-or-rollback',
                children: [
                  // Deploy path — guarded by error check, with confirmation checkpoints
                  new SequenceNode({
                    name: 'deploy-path',
                    children: [
                      new Guard({
                        name: 'no-errors',
                        condition: (ctx) => ctx.blackboard.get('error') == null,
                        child: new ActionNode({
                          name: 'provision',
                          action: (ctx) => {
                            ctx.blackboard.set('provisioned', true);
                            return NodeStatus.SUCCESS;
                          },
                        }),
                      }),
                      untilSuccess(receive('confirm-provision')),

                      // Second guard — re-checked after confirmation
                      new Guard({
                        name: 'still-no-errors',
                        condition: (ctx) => ctx.blackboard.get('error') == null,
                        child: new ActionNode({
                          name: 'configure',
                          action: (ctx) => {
                            ctx.blackboard.set('configured', true);
                            return NodeStatus.SUCCESS;
                          },
                        }),
                      }),
                      untilSuccess(receive('confirm-configure')),

                      new ActionNode({
                        name: 'activate',
                        action: (ctx) => {
                          ctx.blackboard.set('activated', true);
                          return NodeStatus.SUCCESS;
                        },
                      }),
                    ],
                  }),

                  // Rollback path — runs when deploy-path fails
                  new SequenceNode({
                    name: 'rollback-path',
                    children: [
                      new ActionNode({
                        name: 'revert',
                        action: (ctx) => {
                          ctx.blackboard.set('reverted', true);
                          return NodeStatus.SUCCESS;
                        },
                      }),
                      emitToClient('ui:rollback-complete', (ctx) => ({
                        reverted: ctx.blackboard.get('reverted'),
                        error: ctx.blackboard.get('error'),
                      })),
                    ],
                  }),
                ],
              }),
            ],
          }),
        }),
    });

    // 1. Start pipeline — plan-deploy completes, guard passes, provision runs, suspends at confirm-provision
    await harness.client.commandAndWait('tick');

    let bb = await harness.client.blackboard();
    expect(bb['provisioned']).toBe(true);
    expect(bb['configured']).toBeUndefined();

    // 2. Confirm provision — guard still passes, configure runs, suspends at confirm-configure
    await harness.client.commandAndWait('confirm-provision');

    bb = await harness.client.blackboard();
    expect(bb['configured']).toBe(true);
    expect(bb['activated']).toBeUndefined();

    // 3. Write an error to blackboard — re-ticks the tree; reactive guard "no-errors" fails,
    //    deploy-path fails, selector falls through to rollback.
    // Register the rollback event listener BEFORE triggering the write to avoid the race.
    const rollbackPromise = waitForEvent(harness.client, 'ui:rollback-complete', 1, 3000);
    await harness.client.write('error', 'critical failure detected');

    // Wait for rollback processing to complete (reverted key set on blackboard)
    await waitForBlackboard(harness.client, 'reverted', 3000);

    // 4. Verify: deploy-path failed (guard failed), selector fell through to rollback
    bb = await harness.client.blackboard();
    expect(bb['provisioned']).toBe(true);
    expect(bb['configured']).toBe(true);
    expect(bb['activated']).toBeUndefined(); // Never reached
    expect(bb['reverted']).toBe(true);
    expect(bb['error']).toBe('critical failure detected');

    // 5. Verify rollback event received via SSE
    const rollbackEvents = await rollbackPromise;
    expect(rollbackEvents).toHaveLength(1);
    expect(rollbackEvents[0]).toEqual(
      expect.objectContaining({ reverted: true, error: 'critical failure detected' }),
    );
  });
});
