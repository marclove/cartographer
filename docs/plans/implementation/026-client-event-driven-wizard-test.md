# Task 26: Client-Event-Driven Wizard Integration Test

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Test a multi-stage wizard with `emitToClient` at each stage, `mapPayload` extracting form data, retry on validation failure, and blackboard accumulating state across many messages.

**Architecture:** Single integration test file. Tree: 3 retry-wrapped stages (emit form → wait for action → validate), then finalize (create account → emit confirmation). Client submits invalid data on step 2, verifies retry, then completes all stages.

**Tech Stack:** TypeScript, vitest

**Key files to understand:**
- `src/__integration__/helpers.ts` — `setupTest` harness
- `src/decorators/retry.ts` — `RetryNode({ maxAttempts, child })`
- `src/application/action-received.ts` — `actionReceived(name, { mapPayload })`
- `docs/superpowers/specs/2026-03-16-full-stack-feature-tests-design.md` — test 5 spec

---

### Step 1: Create the test file

Create `src/__integration__/client-event-driven-wizard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { SequenceNode } from '../composites/sequence.js';
import { RetryNode } from '../decorators/retry.js';
import { emitToClient } from '../application/emit-to-client.js';
import { actionReceived } from '../application/action-received.js';
import { untilSuccess } from '../application/until-success.js';
import { NodeStatus } from '../types.js';
import { setupTest } from './helpers.js';

function wizardStep(
  stepNumber: number,
  fields: string[],
  bbKey: string,
  validate: (data: Record<string, unknown>) => boolean,
) {
  return new RetryNode({
    name: `step-${stepNumber}-retry`,
    maxAttempts: 3,
    child: new SequenceNode({
      name: `step-${stepNumber}`,
      children: [
        emitToClient('ui:form', () => ({ step: stepNumber, fields })),
        untilSuccess(
          actionReceived(`step-${stepNumber}`, {
            mapPayload: (payload, bb) => {
              bb.set(bbKey, payload);
            },
          }),
        ),
        new ConditionNode({
          name: `validate-step-${stepNumber}`,
          condition: (ctx) => {
            const data = ctx.blackboard.get(bbKey) as Record<string, unknown>;
            return data != null && validate(data);
          },
        }),
      ],
    }),
  });
}

describe('client-event-driven wizard', () => {
  it('3-step onboarding wizard with validation retry and accumulated state', async () => {
    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'onboarding-wizard',
          root: new SequenceNode({
            name: 'main',
            children: [
              // Step 1: Name + email (validate: name non-empty)
              wizardStep(1, ['name', 'email'], 'wizard:step-1', (data) =>
                typeof data.name === 'string' && data.name.length > 0,
              ),

              // Step 2: Company + role (validate: company non-empty)
              wizardStep(2, ['company', 'role'], 'wizard:step-2', (data) =>
                typeof data.company === 'string' && data.company.length > 0,
              ),

              // Step 3: Plan selection (validate: 'starter' or 'pro')
              wizardStep(3, ['plan'], 'wizard:step-3', (data) =>
                data.plan === 'starter' || data.plan === 'pro',
              ),

              // Finalize: create account from accumulated data
              new SequenceNode({
                name: 'finalize',
                children: [
                  new ActionNode({
                    name: 'create-account',
                    action: (ctx) => {
                      const step1 = ctx.blackboard.get('wizard:step-1') as Record<string, unknown>;
                      const step2 = ctx.blackboard.get('wizard:step-2') as Record<string, unknown>;
                      const step3 = ctx.blackboard.get('wizard:step-3') as Record<string, unknown>;
                      ctx.blackboard.set('account', {
                        name: step1?.name,
                        email: step1?.email,
                        company: step2?.company,
                        role: step2?.role,
                        plan: step3?.plan,
                      });
                      return NodeStatus.SUCCESS;
                    },
                  }),
                  emitToClient('ui:confirmation', (ctx) => ctx.blackboard.get('account')),
                ],
              }),
            ],
          }),
        }),
    });

    const formEvents: unknown[] = [];
    const confirmEvents: unknown[] = [];
    harness.client.on('ui:form', (data) => formEvents.push(data));
    harness.client.on('ui:confirmation', (data) => confirmEvents.push(data));

    // 1. Start wizard — step 1 form emitted, suspends
    await harness.client.actionAndWait('tick');
    await new Promise((r) => setTimeout(r, 50));
    expect(formEvents).toHaveLength(1);
    expect(formEvents[0]).toEqual({ step: 1, fields: ['name', 'email'] });

    // 2. Submit step 1 with valid data — validation passes, step 2 form emitted
    await harness.client.actionAndWait('step-1', { name: 'Alice', email: 'alice@acme.com' });
    await new Promise((r) => setTimeout(r, 50));
    expect(formEvents).toHaveLength(2);
    expect(formEvents[1]).toEqual({ step: 2, fields: ['company', 'role'] });

    // 3. Submit step 2 with INVALID data — validation fails, retry re-emits step 2 form
    await harness.client.actionAndWait('step-2', { company: '', role: 'eng' });
    await new Promise((r) => setTimeout(r, 50));
    expect(formEvents).toHaveLength(3);
    expect(formEvents[2]).toEqual({ step: 2, fields: ['company', 'role'] }); // Re-emitted

    // 4. Submit step 2 with valid data — validation passes, step 3 form emitted
    await harness.client.actionAndWait('step-2', { company: 'Acme Corp', role: 'eng' });
    await new Promise((r) => setTimeout(r, 50));
    expect(formEvents).toHaveLength(4);
    expect(formEvents[3]).toEqual({ step: 3, fields: ['plan'] });

    // 5. Submit step 3 — validation passes, account created, confirmation emitted
    const result = await harness.client.actionAndWait('step-3', { plan: 'pro' });
    expect(result.treeStatus).toBe('success');

    // 6. Verify confirmation event with aggregated data
    await new Promise((r) => setTimeout(r, 50));
    expect(confirmEvents).toHaveLength(1);
    expect(confirmEvents[0]).toEqual({
      name: 'Alice',
      email: 'alice@acme.com',
      company: 'Acme Corp',
      role: 'eng',
      plan: 'pro',
    });

    // 7. Verify accumulated blackboard state
    const bb = await harness.client.blackboard();
    expect(bb['wizard:step-1']).toEqual({ name: 'Alice', email: 'alice@acme.com' });
    expect(bb['wizard:step-2']).toEqual({ company: 'Acme Corp', role: 'eng' });
    expect(bb['wizard:step-3']).toEqual({ plan: 'pro' });
    expect(bb['account']).toBeDefined();
  });
});
```

### Step 2: Run the test

Run: `npm run test:integration -- client-event-driven-wizard`
Expected: PASS

### Step 3: Run full integration suite

Run: `npm run test:integration`
Expected: All tests pass

### Step 4: Commit

```bash
git add src/__integration__/client-event-driven-wizard.test.ts
git commit -m "test: add client-event-driven wizard integration test"
```
