import { z } from 'zod/v4';

/**
 * Output schema for the health assessment agent.
 * The agent evaluates the full health history window and classifies
 * overall system status, considering patterns like gradual degradation,
 * flapping, and partial outages.
 */
export const HealthAssessmentSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'outage']),
  reasoning: z.string().describe('Brief explanation of the assessment'),
  affectedServices: z.array(z.string()).describe('Service names that are unhealthy or degraded'),
});

export type HealthAssessment = z.infer<typeof HealthAssessmentSchema>;

/**
 * Output schema for incident reports.
 * Produced when a new outage is detected (no active incident).
 */
export const IncidentReportSchema = z.object({
  title: z.string().describe('Short incident title'),
  severity: z.enum(['critical', 'major', 'minor']),
  summary: z.string().describe('Description of what is happening'),
  affectedServices: z.array(z.string()),
  recommendedActions: z.array(z.string()).describe('Immediate actions to take'),
});

export type IncidentReport = z.infer<typeof IncidentReportSchema>;

/**
 * Output schema for ongoing incident status updates.
 * Produced periodically during an active incident (throttled by guard).
 */
export const StatusUpdateSchema = z.object({
  update: z.string().describe('What has changed since the last update'),
  currentStatus: z.enum(['investigating', 'identified', 'monitoring', 'resolved']),
});

export type StatusUpdate = z.infer<typeof StatusUpdateSchema>;

/**
 * Output schema for resolution summaries.
 * Produced when an incident recovers (was down, now healthy).
 */
export const ResolutionSummarySchema = z.object({
  summary: z.string().describe('What happened and how it was resolved'),
  rootCause: z.string().describe('Likely root cause'),
  duration: z.string().describe('How long the incident lasted'),
  lessonsLearned: z.array(z.string()),
});

export type ResolutionSummary = z.infer<typeof ResolutionSummarySchema>;

/**
 * Shape of a single health check result stored on the blackboard.
 */
export interface HealthRecord {
  healthy: boolean;
  statusCode: number;
  latencyMs: number;
  timestamp: string;
}
