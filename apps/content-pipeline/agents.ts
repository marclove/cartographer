import { z } from 'zod/v4';
import { ClaudeSDKAgent } from 'cartographer';
import {
  ClassificationSchema,
  BillingAnalysisSchema,
  ResponseSchema,
  EscalationSchema,
} from './schemas.js';

export const classifyAgent = new ClaudeSDKAgent({
  name: 'classify',
  model: 'claude-haiku-4-5',
  effort: 'low',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(ClassificationSchema) as any },
});

export const analyzeBillingAgent = new ClaudeSDKAgent({
  name: 'analyze-billing',
  model: 'claude-haiku-4-5',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(BillingAnalysisSchema) as any },
});

export const draftBillingAgent = new ClaudeSDKAgent({
  name: 'draft-billing-response',
  model: 'claude-haiku-4-5',
  maxTurns: 3,
});

export const diagnoseAgent = new ClaudeSDKAgent({
  name: 'diagnose-issue',
  model: 'claude-haiku-4-5',
  maxTurns: 3,
});

export const draftTechnicalAgent = new ClaudeSDKAgent({
  name: 'draft-technical-response',
  model: 'claude-haiku-4-5',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(ResponseSchema) as any },
});

export const draftGeneralAgent = new ClaudeSDKAgent({
  name: 'draft-general-response',
  model: 'claude-haiku-4-5',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(ResponseSchema) as any },
});

export const escalationAgent = new ClaudeSDKAgent({
  name: 'escalation-summary',
  model: 'claude-haiku-4-5',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(EscalationSchema) as any },
});
