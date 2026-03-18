import type { TreeContext } from '../../packages/cartographer/src/index.js';

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
