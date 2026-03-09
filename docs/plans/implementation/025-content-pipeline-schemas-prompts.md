# Task 25: Content Pipeline — Schemas and Prompts

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the Zod output schemas and prompt functions for the content pipeline example. These are the data layer — they define what the AI agents produce and how they're instructed.

**Architecture:** Schemas define structured output shapes for each agent node. Prompts are functions that interpolate blackboard state into instructions. Both are pure data with no side effects, imported by the tree definition.

**Tech Stack:** TypeScript, zod/v4

---

### Step 1: Create schemas

Create `examples/content-pipeline/schemas.ts`:

```typescript
import { z } from 'zod/v4';

/**
 * Output schema for the ticket classifier agent.
 * Determines routing through the pipeline.
 */
export const ClassificationSchema = z.object({
  category: z.enum(['billing', 'technical', 'general']),
  urgency: z.enum(['low', 'medium', 'high']),
  language: z.string().describe('ISO 639-1 language code'),
});

export type Classification = z.infer<typeof ClassificationSchema>;

/**
 * Output schema for billing issue analysis.
 * Extracts structured details from the ticket for response drafting.
 */
export const BillingAnalysisSchema = z.object({
  issueType: z.enum([
    'overcharge',
    'refund_request',
    'subscription_change',
    'payment_method',
    'other',
  ]),
  amountDisputed: z.number().optional().describe('Dollar amount if mentioned'),
  accountIdentifier: z.string().optional().describe('Email or account ID if mentioned'),
  summary: z.string().describe('One-paragraph summary of the billing issue'),
});

export type BillingAnalysis = z.infer<typeof BillingAnalysisSchema>;

/**
 * Output schema for drafted customer responses.
 * Used by billing, technical, and general response agents.
 */
export const ResponseSchema = z.object({
  subject: z.string().describe('Email subject line'),
  body: z.string().describe('Full response body, professional tone'),
  suggestedActions: z.array(z.string()).describe('Internal follow-up actions'),
});

export type Response = z.infer<typeof ResponseSchema>;

/**
 * Output schema for urgent ticket escalation summaries.
 * Only produced when the guard condition detects high urgency.
 */
export const EscalationSchema = z.object({
  summary: z.string().describe('Brief escalation summary for the on-call team'),
  priority: z.enum(['p1', 'p2', 'p3']),
  suggestedOwner: z.string().describe('Team or role best suited to handle this'),
  deadline: z.string().describe('Suggested resolution deadline'),
});

export type Escalation = z.infer<typeof EscalationSchema>;
```

### Step 2: Create prompts

Create `examples/content-pipeline/prompts.ts`:

```typescript
import type { TreeContext } from '../../src/index.js';

/**
 * The sample support ticket used as input for the pipeline.
 * Deliberately billing-related and urgent to exercise the full tree.
 */
export const SAMPLE_TICKET = `Subject: URGENT - Double charged for Pro subscription

I was charged twice for my Pro subscription last month — once on March 1st
and again on March 3rd. That's $49.99 x 2 when it should have been just one
charge. I've been a loyal customer for 3 years and this is really frustrating.

My account email is jane.doe@example.com. Please fix this ASAP or I'll have
to cancel my subscription and switch to a competitor.

— Jane`;

export function classifyPrompt(ctx: TreeContext): string {
  const ticket = ctx.blackboard.get<string>('ticket');
  return [
    'You are a support ticket classifier. Classify the following customer support ticket.',
    '',
    'Ticket:',
    ticket,
    '',
    'Determine the category (billing, technical, or general), urgency (low, medium, or high),',
    'and detect the language (as an ISO 639-1 code).',
  ].join('\n');
}

export function analyzeBillingPrompt(ctx: TreeContext): string {
  const ticket = ctx.blackboard.get<string>('ticket');
  const classification = ctx.blackboard.get('classify:output');
  return [
    'You are a billing specialist analyzing a customer support ticket.',
    '',
    'Ticket:',
    ticket,
    '',
    'Classification:',
    JSON.stringify(classification, null, 2),
    '',
    'Extract the billing issue type, any dollar amounts mentioned, account identifiers,',
    'and provide a one-paragraph summary of the issue.',
  ].join('\n');
}

export function draftBillingResponsePrompt(ctx: TreeContext): string {
  const ticket = ctx.blackboard.get<string>('ticket');
  const analysis = ctx.blackboard.get('analyze-billing:output');
  return [
    'You are a customer support agent specializing in billing issues.',
    'Draft a professional, empathetic response to this customer.',
    '',
    'Original ticket:',
    ticket,
    '',
    'Billing analysis:',
    JSON.stringify(analysis, null, 2),
    '',
    'Write a response with a clear subject line, a professional body that acknowledges',
    'the issue and explains the resolution steps, and a list of internal follow-up actions.',
  ].join('\n');
}

export function diagnoseIssuePrompt(ctx: TreeContext): string {
  const ticket = ctx.blackboard.get<string>('ticket');
  return [
    'You are a senior technical support engineer. Diagnose the technical issue',
    'described in this support ticket. Identify the likely root cause, affected systems,',
    'and recommend troubleshooting steps.',
    '',
    'Ticket:',
    ticket,
  ].join('\n');
}

export function draftTechnicalResponsePrompt(ctx: TreeContext): string {
  const ticket = ctx.blackboard.get<string>('ticket');
  const diagnosis = ctx.blackboard.get('diagnose-issue:output');
  return [
    'You are a technical support agent. Draft a helpful response based on the diagnosis.',
    '',
    'Original ticket:',
    ticket,
    '',
    'Technical diagnosis:',
    typeof diagnosis === 'string' ? diagnosis : JSON.stringify(diagnosis, null, 2),
    '',
    'Write a response with a clear subject line, step-by-step resolution instructions',
    'in the body, and internal follow-up actions.',
  ].join('\n');
}

export function draftGeneralResponsePrompt(ctx: TreeContext): string {
  const ticket = ctx.blackboard.get<string>('ticket');
  return [
    'You are a friendly customer support agent. Draft a helpful response',
    'to this general inquiry.',
    '',
    'Ticket:',
    ticket,
    '',
    'Write a response with a subject line, body, and any suggested follow-up actions.',
  ].join('\n');
}

export function escalationPrompt(ctx: TreeContext): string {
  const ticket = ctx.blackboard.get<string>('ticket');
  const classification = ctx.blackboard.get('classify:output');
  return [
    'This ticket has been flagged as urgent. Write a brief escalation summary',
    'for the on-call team.',
    '',
    'Ticket:',
    ticket,
    '',
    'Classification:',
    JSON.stringify(classification, null, 2),
    '',
    'Include a priority level (p1/p2/p3), the best team or role to handle it,',
    'and a suggested resolution deadline.',
  ].join('\n');
}
```

### Step 3: Verify typecheck

Run: `npm run typecheck`
Expected: PASS (schemas and prompts have no structural errors)

### Step 4: Commit

```bash
git add examples/content-pipeline/schemas.ts examples/content-pipeline/prompts.ts
git commit -m "feat(examples): add content pipeline schemas and prompts"
```
