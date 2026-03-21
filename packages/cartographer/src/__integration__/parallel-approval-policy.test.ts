import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { ParallelNode } from '../composites/parallel.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';
import { emitToClient } from '../nodes/emit-to-client.js';
import { receive } from '../nodes/receive.js';
import { untilSuccess } from '../decorators/until-success.js';
import { NodeStatus } from '../types.js';
import { setupTest, waitForEvent } from './helpers.js';

function reviewerBranch(reviewerName: string, reviewerId: string) {
  return new SequenceNode({
    name: `reviewer-${reviewerId}`,
    children: [
      emitToClient(`ui:review-request`, () => ({
        reviewer: reviewerName,
        reviewerId,
      })),
      untilSuccess(
        receive(reviewerId, {
          mapPayload: (payload, bb) => {
            bb.set(`reviews:${reviewerId}`, payload);
          },
        }),
      ),
    ],
  });
}

describe('parallel approval policy', () => {
  it('2-of-3 approval: early termination after 2 reviewers approve', async () => {
    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'approval-flow',
          root: new SequenceNode({
            name: 'main',
            children: [
              // Step 1: Prepare review materials
              new ActionNode({
                name: 'prepare-review',
                action: (ctx) => {
                  ctx.blackboard.set('review-materials', {
                    title: 'Q4 Architecture Proposal',
                    author: 'engineering',
                  });
                  return NodeStatus.SUCCESS;
                },
              }),

              // Step 2: Parallel reviewers — require 2 of 3 successes
              new ParallelNode({
                name: 'reviewers',
                children: [
                  reviewerBranch('Alice', 'reviewer-1'),
                  reviewerBranch('Bob', 'reviewer-2'),
                  reviewerBranch('Charlie', 'reviewer-3'),
                ],
                strategy: new DefaultParallelStrategy({
                  successCount: 2,
                  failureCount: 2,
                }),
              }),

              // Step 3: Publish after approval
              new ActionNode({
                name: 'publish',
                action: (ctx) => {
                  ctx.blackboard.set('published', true);
                  return NodeStatus.SUCCESS;
                },
              }),
            ],
          }),
        }),
    });

    // 1. Start the flow — prepare runs, all 3 reviewers emit requests, all suspend
    const reviewRequestsPromise = waitForEvent(harness.client, 'ui:review-request', 3);
    const step1Result = await harness.client.actionAndWait('tick');
    expect(step1Result.treeStatus).toBe('running');

    // Verify 3 review request events
    const reviewRequests = await reviewRequestsPromise;
    expect(reviewRequests).toHaveLength(3);
    expect(reviewRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reviewer: 'Alice', reviewerId: 'reviewer-1' }),
        expect.objectContaining({ reviewer: 'Bob', reviewerId: 'reviewer-2' }),
        expect.objectContaining({ reviewer: 'Charlie', reviewerId: 'reviewer-3' }),
      ]),
    );

    // 2. First reviewer approves — parallel still RUNNING (need 2)
    const step2Result = await harness.client.actionAndWait('reviewer-1', { verdict: 'approve' });
    expect(step2Result.treeStatus).toBe('running');
    const bb1 = await harness.client.blackboard();
    expect(bb1['published']).toBeUndefined(); // Not yet published

    // 3. Second reviewer approves — policy satisfied, parallel SUCCESS, publish runs
    const result = await harness.client.actionAndWait('reviewer-2', { verdict: 'approve' });
    expect(result.treeStatus).toBe('success');

    // 4. Verify final state
    const bb2 = await harness.client.blackboard();
    expect(bb2['published']).toBe(true);
    expect(bb2['reviews:reviewer-1']).toEqual({ verdict: 'approve' });
    expect(bb2['reviews:reviewer-2']).toEqual({ verdict: 'approve' });
    // Reviewer 3 was never waited on
    expect(bb2['reviews:reviewer-3']).toBeUndefined();
  });
});
