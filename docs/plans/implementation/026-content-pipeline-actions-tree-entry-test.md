# Task 26: Content Pipeline — Actions, Tree, Entry Point, and Test

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the content pipeline example with condition/action functions, the tree definition, the runnable entry point, and a verification test.

**Architecture:** Actions and conditions are pure functions that read/write blackboard state. The tree definition uses `TreeBuilder` to wire everything together. The entry point sets up the blackboard, attaches event listeners for console output, and ticks the tree. The test verifies end-to-end execution with real Claude API calls.

**Tech Stack:** TypeScript, cartographer (TreeBuilder, NodeStatus, AgentNode)

---

### Step 1: Create actions

Create `examples/content-pipeline/actions.ts`:

```typescript
import { NodeStatus } from '../../src/index.js';
import type { TreeContext } from '../../src/index.js';
import type { Classification } from './schemas.js';

export function isBilling(ctx: TreeContext): boolean {
  const result = ctx.blackboard.get<Classification>('classify:output');
  return result?.category === 'billing';
}

export function isTechnical(ctx: TreeContext): boolean {
  const result = ctx.blackboard.get<Classification>('classify:output');
  return result?.category === 'technical';
}

export function isGeneral(ctx: TreeContext): boolean {
  const result = ctx.blackboard.get<Classification>('classify:output');
  return result?.category === 'general';
}

export function isUrgent(ctx: TreeContext): boolean {
  const result = ctx.blackboard.get<Classification>('classify:output');
  return result?.urgency === 'high';
}

/**
 * Consolidates all agent outputs into a single triage report on the blackboard.
 * Checks all possible response keys since only one path runs per execution.
 */
export function emitResult(ctx: TreeContext): NodeStatus {
  const classification = ctx.blackboard.get('classify:output');

  const billingAnalysis = ctx.blackboard.get('analyze-billing:output');
  const diagnosis = ctx.blackboard.get('diagnose-issue:output');

  const response =
    ctx.blackboard.get('draft-billing-response:output') ??
    ctx.blackboard.get('draft-technical-response:output') ??
    ctx.blackboard.get('draft-general-response:output') ??
    null;

  const escalation = ctx.blackboard.get('escalation-summary:output') ?? null;

  ctx.blackboard.set('triage:report', {
    classification,
    analysis: billingAnalysis ?? diagnosis ?? null,
    response,
    escalation,
  });

  return NodeStatus.SUCCESS;
}
```

### Step 2: Create tree definition

Create `examples/content-pipeline/tree.ts`:

```typescript
import { TreeBuilder, NodeStatus } from '../../src/index.js';
import {
  ClassificationSchema,
  BillingAnalysisSchema,
  ResponseSchema,
  EscalationSchema,
} from './schemas.js';
import {
  classifyPrompt,
  analyzeBillingPrompt,
  draftBillingResponsePrompt,
  diagnoseIssuePrompt,
  draftTechnicalResponsePrompt,
  draftGeneralResponsePrompt,
  escalationPrompt,
} from './prompts.js';
import {
  isBilling,
  isTechnical,
  isGeneral,
  isUrgent,
  emitResult,
} from './actions.js';

/**
 * Builds the content pipeline behavior tree.
 *
 * Tree structure:
 *   sequence "triage"
 *   ├── agent "classify" (structured, haiku)
 *   ├── selector "route-by-category"
 *   │   ├── sequence "billing-path"
 *   │   │   ├── condition "is-billing"
 *   │   │   ├── agent "analyze-billing" (structured, haiku)
 *   │   │   └── retry(2) → agent "draft-billing-response" (agentic, sonnet)
 *   │   ├── sequence "technical-path"
 *   │   │   ├── condition "is-technical"
 *   │   │   ├── retry(2) → agent "diagnose-issue" (agentic, sonnet)
 *   │   │   └── agent "draft-technical-response" (structured, sonnet)
 *   │   └── sequence "general-path"
 *   │       ├── condition "is-general"
 *   │       └── agent "draft-general-response" (structured, haiku)
 *   ├── alwaysSucceed → guard(isUrgent) → agent "escalation-summary" (structured, haiku)
 *   └── action "emit-result"
 */
export function buildContentPipeline() {
  return new TreeBuilder('triage-pipeline')
    .sequence('triage', (b) => {
      // Step 1: Classify the ticket
      b.agent('classify', {
        mode: 'structured',
        prompt: classifyPrompt,
        model: 'haiku',
        effort: 'low',
        outputSchema: ClassificationSchema,
      });

      // Step 2: Route based on classification
      b.selector('route-by-category', (b) => {
        b.sequence('billing-path', (b) => {
          b.condition('is-billing', isBilling);
          b.agent('analyze-billing', {
            mode: 'structured',
            prompt: analyzeBillingPrompt,
            model: 'haiku',
            outputSchema: BillingAnalysisSchema,
          });
          b.retry('draft-billing-retry', { maxAttempts: 2 }, (b) => {
            b.agent('draft-billing-response', {
              mode: 'agentic',
              prompt: draftBillingResponsePrompt,
              model: 'sonnet',
              maxTurns: 3,
            });
          });
        });

        b.sequence('technical-path', (b) => {
          b.condition('is-technical', isTechnical);
          b.retry('diagnose-retry', { maxAttempts: 2 }, (b) => {
            b.agent('diagnose-issue', {
              mode: 'agentic',
              prompt: diagnoseIssuePrompt,
              model: 'sonnet',
              maxTurns: 3,
            });
          });
          b.agent('draft-technical-response', {
            mode: 'structured',
            prompt: draftTechnicalResponsePrompt,
            model: 'sonnet',
            outputSchema: ResponseSchema,
          });
        });

        b.sequence('general-path', (b) => {
          b.condition('is-general', isGeneral);
          b.agent('draft-general-response', {
            mode: 'structured',
            prompt: draftGeneralResponsePrompt,
            model: 'haiku',
            outputSchema: ResponseSchema,
          });
        });
      });

      // Step 3: Conditional escalation for urgent tickets.
      // Guard returns FAILURE when condition is false, which would fail the
      // outer sequence. Wrapping in alwaysSucceed makes escalation optional.
      b.alwaysSucceed('optional-escalation', (b) => {
        b.guard('escalation-gate', { condition: isUrgent }, (b) => {
          b.agent('escalation-summary', {
            mode: 'structured',
            prompt: escalationPrompt,
            model: 'haiku',
            outputSchema: EscalationSchema,
          });
        });
      });

      // Step 4: Consolidate results
      b.action('emit-result', emitResult);
    })
    .build();
}
```

### Step 3: Create entry point

Create `examples/content-pipeline/index.ts`:

```typescript
import { NodeStatus } from '../../src/index.js';
import type { TreeEvents } from '../../src/index.js';
import { buildContentPipeline } from './tree.js';
import { SAMPLE_TICKET } from './prompts.js';
import type { Classification, BillingAnalysis, Response, Escalation } from './schemas.js';

async function main() {
  const tree = buildContentPipeline();
  tree.blackboard.set('ticket', SAMPLE_TICKET);

  // Track costs per agent
  const costs: Record<string, number> = {};
  tree.events.on('agent:response', (event: TreeEvents['agent:response']) => {
    const name = event.node.name;
    if (event.cost !== undefined) {
      costs[name] = (costs[name] ?? 0) + event.cost;
    }
  });

  // Log node execution for visibility
  tree.events.on('node:enter', (event: TreeEvents['node:enter']) => {
    console.log(`  -> entering: ${event.node.name}`);
  });

  console.log('=== Support Ticket Triage Pipeline ===\n');
  console.log('INCOMING TICKET:');
  console.log(SAMPLE_TICKET);
  console.log('\nPROCESSING...\n');

  const start = performance.now();
  const { status, blackboard } = await tree.run();
  const durationMs = performance.now() - start;

  // Print classification
  const classification = blackboard['classify:output'] as Classification | undefined;
  if (classification) {
    console.log('\n--- Classification ---');
    console.log(`  Category: ${classification.category}`);
    console.log(`  Urgency:  ${classification.urgency}`);
    console.log(`  Language: ${classification.language}`);
  }

  // Print analysis (if billing path)
  const analysis = blackboard['analyze-billing:output'] as BillingAnalysis | undefined;
  if (analysis) {
    console.log('\n--- Billing Analysis ---');
    console.log(`  Issue type: ${analysis.issueType}`);
    if (analysis.amountDisputed) console.log(`  Amount:     $${analysis.amountDisputed}`);
    if (analysis.accountIdentifier) console.log(`  Account:    ${analysis.accountIdentifier}`);
    console.log(`  Summary:    ${analysis.summary}`);
  }

  // Print diagnosis (if technical path)
  const diagnosis = blackboard['diagnose-issue:output'] as string | undefined;
  if (diagnosis) {
    console.log('\n--- Technical Diagnosis ---');
    console.log(`  ${diagnosis}`);
  }

  // Print response
  const response = (
    blackboard['draft-billing-response:output'] ??
    blackboard['draft-technical-response:output'] ??
    blackboard['draft-general-response:output']
  ) as Response | string | undefined;

  if (response) {
    console.log('\n--- Drafted Response ---');
    if (typeof response === 'string') {
      console.log(response);
    } else {
      console.log(`  Subject: ${response.subject}`);
      console.log(`  Body:\n${response.body}`);
      if (response.suggestedActions.length > 0) {
        console.log('  Actions:');
        for (const action of response.suggestedActions) {
          console.log(`    - ${action}`);
        }
      }
    }
  }

  // Print escalation (if urgent)
  const escalation = blackboard['escalation-summary:output'] as Escalation | undefined;
  if (escalation) {
    console.log('\n--- Escalation ---');
    console.log(`  Priority: ${escalation.priority}`);
    console.log(`  Owner:    ${escalation.suggestedOwner}`);
    console.log(`  Deadline: ${escalation.deadline}`);
    console.log(`  Summary:  ${escalation.summary}`);
  }

  // Print cost breakdown
  console.log('\n--- Cost Breakdown ---');
  let totalCost = 0;
  for (const [name, cost] of Object.entries(costs)) {
    console.log(`  ${name.padEnd(30)} $${cost.toFixed(4)}`);
    totalCost += cost;
  }
  console.log(`  ${'Total'.padEnd(30)} $${totalCost.toFixed(4)}`);

  console.log(`\nPipeline completed: ${status} (${(durationMs / 1000).toFixed(1)}s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

### Step 4: Create test

Create `examples/content-pipeline/content-pipeline.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { NodeStatus } from '../../src/index.js';
import { buildContentPipeline } from './tree.js';
import { SAMPLE_TICKET } from './prompts.js';

describe('content-pipeline example', { timeout: 120_000 }, () => {
  it('processes a support ticket end-to-end', async () => {
    const tree = buildContentPipeline();
    tree.blackboard.set('ticket', SAMPLE_TICKET);

    const { status, blackboard } = await tree.run();

    // Pipeline should complete successfully
    expect(status).toBe(NodeStatus.SUCCESS);

    // Classification should exist with expected shape
    const classification = blackboard['classify:output'] as Record<string, unknown>;
    expect(classification).toBeDefined();
    expect(classification.category).toBeDefined();
    expect(classification.urgency).toBeDefined();

    // Triage report should be consolidated
    const report = blackboard['triage:report'] as Record<string, unknown>;
    expect(report).toBeDefined();
    expect(report.classification).toBeDefined();
    expect(report.response).toBeDefined();
  });
});
```

### Step 5: Verify typecheck

Run: `npm run typecheck`
Expected: PASS

### Step 6: Run the example

Run: `npx tsx examples/content-pipeline/index.ts`
Expected: Pipeline processes the ticket, prints classification, analysis, response, escalation, and cost breakdown.

### Step 7: Run the test

Run: `npm run test:examples`
Expected: PASS (1 test)

### Step 8: Commit

```bash
git add examples/content-pipeline/
git commit -m "feat(examples): add content pipeline example — support ticket triage with agent routing"
```
