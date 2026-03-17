# Task 24: Parallel Approval Policy Integration Test

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Test parallel node with 2-of-3 success policy, early termination, and `untilSuccess` suspension within parallel children.

**Architecture:** Single integration test file. Tree: prepare-review → parallel(3 reviewer sequences, require 2 successes) → publish. Each reviewer sequence: emit review request → wait for action. After 2 approvals, parallel returns SUCCESS without waiting for reviewer 3.

**Tech Stack:** TypeScript, vitest

**Key files to understand:**
- `src/__integration__/helpers.ts` — `setupTest` harness
- `src/composites/parallel.ts` — `ParallelNode`, policy evaluation
- `src/strategies/default-parallel.ts` — `DefaultParallelStrategy({ successCount, failureCount })`
- `docs/superpowers/specs/2026-03-16-full-stack-feature-tests-design.md` — test 3 spec

---

### Step 1: Create the test file

Create `src/__integration__/parallel-approval-policy.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { ParallelNode } from '../composites/parallel.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';
import { emitToClient } from '../application/emit-to-client.js';
import { actionReceived } from '../application/action-received.js';
import { untilSuccess } from '../application/until-success.js';
import { NodeStatus } from '../types.js';
import { setupTest } from './helpers.js';

function reviewerBranch(reviewerName: string, reviewerId: string) {
  return new SequenceNode({
    name: `reviewer-${reviewerId}`,
    children: [
      emitToClient(`ui:review-request`, () => ({
        reviewer: reviewerName,
        reviewerId,
      })),
      untilSuccess(
        actionReceived(reviewerId, {
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
    const reviewRequests: unknown[] = [];
    harness.client.on('ui:review-request', (data) => reviewRequests.push(data));
    await harness.client.actionAndWait('tick');
    await new Promise((r) => setTimeout(r, 50));

    // Verify 3 review request events
    expect(reviewRequests).toHaveLength(3);
    expect(reviewRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reviewer: 'Alice', reviewerId: 'reviewer-1' }),
        expect.objectContaining({ reviewer: 'Bob', reviewerId: 'reviewer-2' }),
        expect.objectContaining({ reviewer: 'Charlie', reviewerId: 'reviewer-3' }),
      ]),
    );

    // 2. First reviewer approves — parallel still RUNNING (need 2)
    await harness.client.actionAndWait('reviewer-1', { verdict: 'approve' });
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
```

### Step 2: Run the test

Run: `npm run test:integration -- parallel-approval-policy`
Expected: PASS

### Step 3: Run full integration suite

Run: `npm run test:integration`
Expected: All tests pass

### Step 4: Commit

```bash
git add src/__integration__/parallel-approval-policy.test.ts
git commit -m "test: add parallel approval policy integration test"
```
