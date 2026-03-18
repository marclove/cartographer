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
