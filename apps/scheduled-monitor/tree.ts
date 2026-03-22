import { z } from 'zod/v4';
import { TreeBuilder, NodeStatus, ClaudeSDKAgent } from 'cartographer';
import {
  HealthAssessmentSchema,
  IncidentReportSchema,
  StatusUpdateSchema,
  ResolutionSummarySchema,
} from './schemas.js';
import {
  assessHealthPrompt,
  draftIncidentReportPrompt,
  draftStatusUpdatePrompt,
  draftResolutionPrompt,
} from './prompts.js';
import {
  createHealthCheck,
  updateHistory,
  incrementCycleCount,
  isUnhealthy,
  wasDownNowHealthy,
  noActiveIncident,
  enoughTimeSinceLastUpdate,
  recordIncidentCycle,
  clearIncidentState,
  logHealthy,
} from './actions.js';

// --- Agent definitions ---

const assessHealthAgent = new ClaudeSDKAgent({
  name: 'assess-health',
  model: 'claude-haiku-4-5',
  effort: 'low',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(HealthAssessmentSchema) as any },
});

const incidentReportAgent = new ClaudeSDKAgent({
  name: 'draft-incident-report',
  model: 'claude-haiku-4-5',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(IncidentReportSchema) as any },
});

const statusUpdateAgent = new ClaudeSDKAgent({
  name: 'draft-status-update',
  model: 'claude-haiku-4-5',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(StatusUpdateSchema) as any },
});

const resolutionAgent = new ClaudeSDKAgent({
  name: 'draft-resolution',
  model: 'claude-haiku-4-5',
  outputFormat: { type: 'json_schema', schema: z.toJSONSchema(ResolutionSummarySchema) as any },
});

// --- Tree definition ---

/**
 * Builds the health monitor behavior tree.
 *
 * Tree structure:
 *   sequence "monitor"
 *   ├── parallel "check-all-services"
 *   │   ├── action "check-api"
 *   │   ├── action "check-database"
 *   │   └── action "check-queue"
 *   ├── action "update-history"
 *   ├── alwaysSucceed → timeout(10s) → agent "assess-health" (structured)
 *   ├── selector "respond-to-assessment"
 *   │   ├── sequence "outage-path"
 *   │   │   ├── condition "is-unhealthy"
 *   │   │   ├── selector "outage-actions"
 *   │   │   │   ├── sequence "new-outage"
 *   │   │   │   │   ├── condition "no-active-incident"
 *   │   │   │   │   └── agent "draft-incident-report" (structured)
 *   │   │   │   ├── guard(enoughTimeSinceLastUpdate) → agent "draft-status-update" (structured)
 *   │   │   │   └── action "skip-update"
 *   │   │   └── action "record-incident-cycle"
 *   │   ├── sequence "recovery-path"
 *   │   │   ├── condition "was-down-now-healthy"
 *   │   │   ├── agent "draft-resolution" (structured)
 *   │   │   └── action "clear-incident"
 *   │   └── action "log-healthy"
 *   └── action "increment-cycle"
 *
 * @param baseUrl Base URL of the test server (e.g. "http://localhost:3456")
 */
export function buildHealthMonitor(baseUrl: string) {
  return new TreeBuilder('health-monitor')
    .sequence('monitor', (b) => {
      // Check all services concurrently
      b.parallel('check-all-services', (b) => {
        b.action('check-api', createHealthCheck('api', baseUrl));
        b.action('check-database', createHealthCheck('database', baseUrl));
        b.action('check-queue', createHealthCheck('queue', baseUrl));
      });

      b.action('update-history', updateHistory);

      // AI health assessment with timeout fallback.
      b.alwaysSucceed('assess-with-fallback', (b) => {
        b.timeout('assess-timeout', { timeoutMs: 15_000 }, (b) => {
          b.agent('assess-health', { agent: assessHealthAgent, prompt: assessHealthPrompt });
        });
      });

      // Respond based on assessment
      b.selector('respond-to-assessment', (b) => {
        // Outage path
        b.sequence('outage-path', (b) => {
          b.condition('is-unhealthy', isUnhealthy);
          b.selector('outage-actions', (b) => {
            // New outage: draft initial incident report
            b.sequence('new-outage', (b) => {
              b.condition('no-active-incident', noActiveIncident);
              b.agent('draft-incident-report', { agent: incidentReportAgent, prompt: draftIncidentReportPrompt });
            });
            // Ongoing outage: periodic status update (throttled)
            b.guard('throttle-updates', { condition: enoughTimeSinceLastUpdate }, (b) => {
              b.agent('draft-status-update', { agent: statusUpdateAgent, prompt: draftStatusUpdatePrompt });
            });
            // Fallback: no update needed this tick
            b.action('skip-update', () => NodeStatus.SUCCESS);
          });
          b.action('record-incident-cycle', recordIncidentCycle);
        });

        // Recovery path
        b.sequence('recovery-path', (b) => {
          b.condition('was-down-now-healthy', wasDownNowHealthy);
          b.agent('draft-resolution', { agent: resolutionAgent, prompt: draftResolutionPrompt });
          b.action('clear-incident', clearIncidentState);
        });

        // Healthy fallback
        b.action('log-healthy', logHealthy);
      });

      b.action('increment-cycle', incrementCycleCount);
    })
    .build();
}
