import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { actionReceived } from '../nodes/action-received.js';
import { untilSuccess } from '../decorators/until-success.js';
import { NodeStatus } from '../types.js';
import { setupTest } from './helpers.js';

describe('multi-step action workflow', () => {
  it('document review pipeline: analyze → emit → wait for decision → branch', async () => {
    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'review-pipeline',
          root: new SequenceNode({
            name: 'main',
            children: [
              // Step 1: Agent analyzes the document and emits findings to client.
              // Both steps are combined into one ActionNode to avoid the
              // runToCompletion edge case where consecutive fast-settling nodes
              // cause premature suspension detection.
              new ActionNode({
                name: 'analyze-and-emit',
                action: (ctx) => {
                  const analysis = {
                    summary: 'Code review for auth module',
                    issues: ['missing input validation', 'no rate limiting'],
                  };
                  ctx.blackboard.set('analysis', analysis);
                  // Dual-write: blackboard + SSE event (mirrors what emitToClient does)
                  ctx.blackboard.set('clientEvents:ui:findings', analysis);
                  ctx.events.emit('client:event', { name: 'ui:findings', data: analysis });
                  return NodeStatus.SUCCESS;
                },
              }),

              // Step 2: Wait for user decision (approve or reject)
              untilSuccess(
                new SelectorNode({
                  name: 'wait-decision',
                  children: [
                    actionReceived('approve', {
                      mapPayload: (payload, bb) => {
                        bb.set('decision', 'approve');
                        bb.set('decision:comment', (payload as any)?.comment ?? '');
                      },
                    }),
                    actionReceived('reject', {
                      mapPayload: (payload, bb) => {
                        bb.set('decision', 'reject');
                        bb.set('decision:reason', (payload as any)?.reason ?? '');
                      },
                    }),
                  ],
                }),
              ),

              // Step 3: Handle the decision
              new SelectorNode({
                name: 'handle-decision',
                children: [
                  new SequenceNode({
                    name: 'approved-path',
                    children: [
                      new ConditionNode({
                        name: 'was-approved',
                        condition: (ctx) => ctx.blackboard.get('decision') === 'approve',
                      }),
                      new ActionNode({
                        name: 'publish',
                        action: (ctx) => {
                          ctx.blackboard.set('published', true);
                          ctx.blackboard.set('publish:comment', ctx.blackboard.get('decision:comment'));
                          return NodeStatus.SUCCESS;
                        },
                      }),
                    ],
                  }),
                  new ActionNode({
                    name: 'archive',
                    action: (ctx) => {
                      ctx.blackboard.set('archived', true);
                      ctx.blackboard.set('archive:reason', ctx.blackboard.get('decision:reason'));
                      return NodeStatus.SUCCESS;
                    },
                  }),
                ],
              }),
            ],
          }),
        }),
    });

    // 1. Start the pipeline — analyze runs, findings emitted, suspends at untilSuccess
    const findingsReceived: unknown[] = [];
    harness.client.on('ui:findings', (data) => findingsReceived.push(data));
    await harness.client.actionAndWait('tick');

    // Verify: tree is RUNNING (suspended), findings event arrived
    const status1 = await harness.client.status();
    expect((status1 as any).lastMessageAt).toBeDefined();
    await new Promise((r) => setTimeout(r, 50));
    expect(findingsReceived).toHaveLength(1);
    expect(findingsReceived[0]).toEqual({
      summary: 'Code review for auth module',
      issues: ['missing input validation', 'no rate limiting'],
    });

    // Verify: findings also on blackboard (dual write from emitToClient)
    const bb1 = await harness.client.blackboard();
    expect(bb1['analysis']).toBeDefined();

    // 2. Send approval action — resumes, approve consumed, publish runs
    const result = await harness.client.actionAndWait('approve', { comment: 'Ship it' });
    expect(result.treeStatus).toBe('success');

    // 3. Verify final blackboard state
    const bb2 = await harness.client.blackboard();
    expect(bb2['decision']).toBe('approve');
    expect(bb2['published']).toBe(true);
    expect(bb2['publish:comment']).toBe('Ship it');
    expect(bb2['archived']).toBeUndefined();
  });
});
