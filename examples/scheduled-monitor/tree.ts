import { TreeBuilder, NodeStatus } from '../../src/index.js';
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
  incrementTickCount,
  isUnhealthy,
  wasDownNowHealthy,
  noActiveIncident,
  enoughTimeSinceLastUpdate,
  recordIncidentTick,
  clearIncidentState,
  logHealthy,
} from './actions.js';

/**
 * Builds the health monitor behavior tree.
 *
 * Tree structure:
 *   sequence "monitor"
 *   ├── action "increment-tick"
 *   ├── parallel "check-all-services"
 *   │   ├── action "check-api"
 *   │   ├── action "check-database"
 *   │   └── action "check-queue"
 *   ├── action "update-history"
 *   ├── alwaysSucceed → timeout(10s) → agent "assess-health" (structured, haiku)
 *   ├── selector "respond-to-assessment"
 *   │   ├── sequence "outage-path"
 *   │   │   ├── condition "is-unhealthy"
 *   │   │   ├── selector "outage-actions"
 *   │   │   │   ├── sequence "new-outage"
 *   │   │   │   │   ├── condition "no-active-incident"
 *   │   │   │   │   └── agent "draft-incident-report" (structured, sonnet)
 *   │   │   │   ├── guard(enoughTimeSinceLastUpdate) → agent "draft-status-update" (structured, haiku)
 *   │   │   │   └── action "skip-update"
 *   │   │   └── action "record-incident-tick"
 *   │   ├── sequence "recovery-path"
 *   │   │   ├── condition "was-down-now-healthy"
 *   │   │   ├── agent "draft-resolution" (structured, sonnet)
 *   │   │   └── action "clear-incident"
 *   │   └── action "log-healthy"
 *
 * @param baseUrl Base URL of the test server (e.g. "http://localhost:3456")
 */
export function buildHealthMonitor(baseUrl: string) {
  return new TreeBuilder('health-monitor')
    .sequence('monitor', (b) => {
      b.action('increment-tick', incrementTickCount);

      // Check all services concurrently
      b.parallel('check-all-services', (b) => {
        b.action('check-api', createHealthCheck('api', baseUrl));
        b.action('check-database', createHealthCheck('database', baseUrl));
        b.action('check-queue', createHealthCheck('queue', baseUrl));
      });

      b.action('update-history', updateHistory);

      // AI health assessment with timeout fallback.
      // Wrapped in alwaysSucceed so the pipeline continues even
      // if the agent times out — stale assessment is better than
      // no response at all.
      b.alwaysSucceed('assess-with-fallback', (b) => {
        b.timeout('assess-timeout', { timeoutMs: 30_000 }, (b) => {
          b.agent('assess-health', {
            mode: 'structured',
            prompt: assessHealthPrompt,
            model: 'haiku',
            effort: 'low',
            outputSchema: HealthAssessmentSchema,
          });
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
              b.agent('draft-incident-report', {
                mode: 'structured',
                prompt: draftIncidentReportPrompt,
                model: 'sonnet',
                outputSchema: IncidentReportSchema,
              });
            });
            // Ongoing outage: periodic status update (throttled)
            b.guard('throttle-updates', { condition: enoughTimeSinceLastUpdate }, (b) => {
              b.agent('draft-status-update', {
                mode: 'structured',
                prompt: draftStatusUpdatePrompt,
                model: 'haiku',
                outputSchema: StatusUpdateSchema,
              });
            });
            // Fallback: no update needed this tick
            b.action('skip-update', () => NodeStatus.SUCCESS);
          });
          b.action('record-incident-tick', recordIncidentTick);
        });

        // Recovery path
        b.sequence('recovery-path', (b) => {
          b.condition('was-down-now-healthy', wasDownNowHealthy);
          b.agent('draft-resolution', {
            mode: 'structured',
            prompt: draftResolutionPrompt,
            model: 'sonnet',
            outputSchema: ResolutionSummarySchema,
          });
          b.action('clear-incident', clearIncidentState);
        });

        // Healthy fallback
        b.action('log-healthy', logHealthy);
      });
    })
    .build();
}
