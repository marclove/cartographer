# Task 25: Selector Preemption Reactive Integration Test

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Test selector preemption via reactive guard conditions in a deploy-with-rollback pipeline.

**Architecture:** Single integration test file. Tree: plan-deploy → selector(deploy-path with guards + confirmation checkpoints, rollback-path). Client confirms provision, then writes an error to the blackboard. On next message, the reactive guard fails, deploy-path fails, selector falls through to rollback.

**Tech Stack:** TypeScript, vitest

**Key files to understand:**
- `src/__integration__/helpers.ts` — `setupTest` harness
- `src/decorators/guard.ts` — `GuardNode` (reactive, re-evaluated each tick)
- `src/application/action-received.ts` — suspension checkpoints
- `docs/superpowers/specs/2026-03-16-full-stack-feature-tests-design.md` — test 4 spec

---

### Step 1: Create the test file

Create `src/__integration__/selector-preemption-reactive.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { GuardNode } from '../decorators/guard.js';
import { emitToClient } from '../application/emit-to-client.js';
import { actionReceived } from '../application/action-received.js';
import { untilSuccess } from '../application/until-success.js';
import { NodeStatus } from '../types.js';
import { setupTest } from './helpers.js';

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
                      new GuardNode({
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
                      untilSuccess(actionReceived('confirm-provision')),

                      // Second guard — re-checked after confirmation
                      new GuardNode({
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
                      untilSuccess(actionReceived('confirm-configure')),

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
    await harness.client.actionAndWait('tick');

    let bb = await harness.client.blackboard();
    expect(bb['provisioned']).toBe(true);
    expect(bb['configured']).toBeUndefined();

    // 2. Confirm provision — guard still passes, configure runs, suspends at confirm-configure
    await harness.client.actionAndWait('confirm-provision');

    bb = await harness.client.blackboard();
    expect(bb['configured']).toBe(true);
    expect(bb['activated']).toBeUndefined();

    // 3. Write an error to blackboard — clears confirm-configure suspension, guard "still-no-errors" fails
    const rollbackEvents: unknown[] = [];
    harness.client.on('ui:rollback-complete', (data) => rollbackEvents.push(data));

    await harness.client.write('error', 'critical failure detected');

    // Wait for processing to complete
    await new Promise((r) => setTimeout(r, 200));

    // 4. Verify: deploy-path failed (guard failed), selector fell through to rollback
    bb = await harness.client.blackboard();
    expect(bb['provisioned']).toBe(true);
    expect(bb['configured']).toBe(true);
    expect(bb['activated']).toBeUndefined(); // Never reached
    expect(bb['reverted']).toBe(true);
    expect(bb['error']).toBe('critical failure detected');

    // 5. Verify rollback event received
    await new Promise((r) => setTimeout(r, 50));
    expect(rollbackEvents).toHaveLength(1);
    expect(rollbackEvents[0]).toEqual(
      expect.objectContaining({ reverted: true, error: 'critical failure detected' }),
    );
  });
});
```

### Step 2: Run the test

Run: `npm run test:integration -- selector-preemption-reactive`
Expected: PASS

### Step 3: Run full integration suite

Run: `npm run test:integration`
Expected: All tests pass

### Step 4: Commit

```bash
git add src/__integration__/selector-preemption-reactive.test.ts
git commit -m "test: add selector preemption reactive integration test"
```
