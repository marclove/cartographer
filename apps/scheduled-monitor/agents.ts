import { z } from 'zod/v4';
import { ClaudeSDKAgent } from 'cartographer';
import {
  HealthAssessmentSchema,
  IncidentReportSchema,
  StatusUpdateSchema,
  ResolutionSummarySchema,
} from './schemas.js';

export const assessHealthAgent = new ClaudeSDKAgent({
  name: 'assess-health',
  model: 'claude-haiku-4-5',
  effort: 'low',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(HealthAssessmentSchema) as any },
});

export const incidentReportAgent = new ClaudeSDKAgent({
  name: 'draft-incident-report',
  model: 'claude-haiku-4-5',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(IncidentReportSchema) as any },
});

export const statusUpdateAgent = new ClaudeSDKAgent({
  name: 'draft-status-update',
  model: 'claude-haiku-4-5',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(StatusUpdateSchema) as any },
});

export const resolutionAgent = new ClaudeSDKAgent({
  name: 'draft-resolution',
  model: 'claude-haiku-4-5',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(ResolutionSummarySchema) as any },
});
