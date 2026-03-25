import { describe, it, expect } from 'vitest';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { SequenceNode } from '../composites/sequence.js';
import { Retry } from '../decorators/retry.js';
import { emitToClient } from '../nodes/emit-to-client.js';
import { receive } from '../nodes/receive.js';
import { untilSuccess } from '../decorators/until-success.js';
import { NodeStatus } from '../types.js';
import { setupTest, waitForEvent } from './helpers.js';

function wizardStep(
  stepNumber: number,
  fields: string[],
  bbKey: string,
  validate: (data: Record<string, unknown>) => boolean,
) {
  return new Retry({
    name: `step-${stepNumber}-retry`,
    maxAttempts: 3,
    child: new SequenceNode({
      name: `step-${stepNumber}`,
      children: [
        emitToClient('ui:form', () => ({ step: stepNumber, fields })),
        untilSuccess(
          receive(`step-${stepNumber}`, {
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

              // Finalize: create account from accumulated data and emit confirmation.
              // Combined into a single ActionNode to avoid the runToCompletion edge
              // case where consecutive fast-settling nodes cause premature suspension
              // detection.
              new ActionNode({
                name: 'create-account-and-confirm',
                action: (ctx) => {
                  const step1 = ctx.blackboard.get('wizard:step-1') as Record<string, unknown>;
                  const step2 = ctx.blackboard.get('wizard:step-2') as Record<string, unknown>;
                  const step3 = ctx.blackboard.get('wizard:step-3') as Record<string, unknown>;
                  const account = {
                    name: step1?.name,
                    email: step1?.email,
                    company: step2?.company,
                    role: step2?.role,
                    plan: step3?.plan,
                  };
                  ctx.blackboard.set('account', account);
                  // Dual-write: blackboard + SSE event (mirrors what emitToClient does)
                  ctx.blackboard.set('clientEvents:ui:confirmation', account);
                  ctx.events.emit('client:event', { name: 'ui:confirmation', data: account });
                  return NodeStatus.SUCCESS;
                },
              }),
            ],
          }),
        }),
    });

    // 1. Start wizard — step 1 form emitted, suspends
    const form1Promise = waitForEvent(harness.client, 'ui:form', 1);
    const step1Result = await harness.client.commandAndWait('tick');
    expect(step1Result.treeStatus).toBe('running');
    const [form1Data] = await form1Promise;
    expect(form1Data).toEqual({ step: 1, fields: ['name', 'email'] });

    // 2. Submit step 1 with valid data — validation passes, step 2 form emitted
    const form2Promise = waitForEvent(harness.client, 'ui:form', 1);
    const step2StartResult = await harness.client.commandAndWait('step-1', { name: 'Alice', email: 'alice@acme.com' });
    expect(step2StartResult.treeStatus).toBe('running');
    const [form2Data] = await form2Promise;
    expect(form2Data).toEqual({ step: 2, fields: ['company', 'role'] });

    // 3. Submit step 2 with INVALID data — validation fails, retry re-emits step 2 form
    const form3Promise = waitForEvent(harness.client, 'ui:form', 1);
    const invalidResult = await harness.client.commandAndWait('step-2', { company: '', role: 'eng' });
    expect(invalidResult.treeStatus).toBe('running');
    const [form3Data] = await form3Promise;
    expect(form3Data).toEqual({ step: 2, fields: ['company', 'role'] }); // Re-emitted

    // 4. Submit step 2 with valid data — validation passes, step 3 form emitted
    const form4Promise = waitForEvent(harness.client, 'ui:form', 1);
    const step2ValidResult = await harness.client.commandAndWait('step-2', { company: 'Acme Corp', role: 'eng' });
    expect(step2ValidResult.treeStatus).toBe('running');
    const [form4Data] = await form4Promise;
    expect(form4Data).toEqual({ step: 3, fields: ['plan'] });

    // Intermediate check: after step 2 succeeds, both step-1 and step-2 data are on the blackboard
    const bbMid = await harness.client.blackboard();
    expect(bbMid['wizard:step-1']).toEqual({ name: 'Alice', email: 'alice@acme.com' });
    expect(bbMid['wizard:step-2']).toEqual({ company: 'Acme Corp', role: 'eng' });

    // 5. Submit step 3 — validation passes, account created, confirmation emitted
    const confirmPromise = waitForEvent(harness.client, 'ui:confirmation', 1);
    const finalResult = await harness.client.commandAndWait('step-3', { plan: 'pro' });
    expect(finalResult.treeStatus).toBe('success');

    // 6. Verify confirmation event with aggregated data
    const [confirmData] = await confirmPromise;
    expect(confirmData).toEqual({
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
