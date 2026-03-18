import type { TreeContext } from '../../packages/cartographer/src/index.js';
import type { HealthRecord } from './schemas.js';

const SERVICES = ['api', 'database', 'queue'];

/**
 * Formats the health history window into a readable string for agent prompts.
 */
function formatHistory(ctx: TreeContext): string {
  const sections: string[] = [];
  for (const service of SERVICES) {
    const history = ctx.blackboard.get<HealthRecord[]>(`history:${service}`) ?? [];
    if (history.length === 0) continue;
    const lines = history.map((r, i) =>
      `  [${i + 1}] status=${r.statusCode} latency=${r.latencyMs}ms healthy=${r.healthy} (${r.timestamp})`
    );
    sections.push(`${service}:\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}

export function assessHealthPrompt(ctx: TreeContext): string {
  return [
    'You are a site reliability engineer assessing system health.',
    'Analyze the following health check history for three services.',
    'Look for patterns: gradual degradation (rising latency), outages',
    '(error status codes), flapping (alternating up/down), and partial',
    'failures (some services down, others up).',
    '',
    'Health check history (most recent last):',
    formatHistory(ctx),
    '',
    'Current health snapshot:',
    SERVICES.map((s) => {
      const r = ctx.blackboard.get<HealthRecord>(`health:${s}`);
      return r ? `  ${s}: status=${r.statusCode} latency=${r.latencyMs}ms` : `  ${s}: no data`;
    }).join('\n'),
    '',
    'Classify overall status as healthy, degraded, or outage.',
    'List any affected services by name.',
  ].join('\n');
}

export function draftIncidentReportPrompt(ctx: TreeContext): string {
  return [
    'A new service incident has been detected. Draft an incident report.',
    '',
    'Health check history:',
    formatHistory(ctx),
    '',
    'Provide a concise title, severity level, summary of what is happening,',
    'list of affected services, and recommended immediate actions.',
  ].join('\n');
}

export function draftStatusUpdatePrompt(ctx: TreeContext): string {
  const incidentStart = ctx.blackboard.get<string>('incident:startTime');
  const previousUpdates = ctx.blackboard.get<string[]>('incident:updates') ?? [];
  return [
    'An ongoing incident needs a status update.',
    '',
    `Incident started: ${incidentStart}`,
    previousUpdates.length > 0
      ? `Previous updates:\n${previousUpdates.map((u, i) => `  [${i + 1}] ${u}`).join('\n')}`
      : 'No previous updates.',
    '',
    'Current health:',
    formatHistory(ctx),
    '',
    'Describe what has changed since the last update and the current investigation status.',
  ].join('\n');
}

export function draftResolutionPrompt(ctx: TreeContext): string {
  const incidentStart = ctx.blackboard.get<string>('incident:startTime');
  const now = new Date().toISOString();
  const previousUpdates = ctx.blackboard.get<string[]>('incident:updates') ?? [];
  return [
    'The incident has been resolved — all services are now healthy.',
    '',
    `Incident started: ${incidentStart}`,
    `Resolved at: ${now}`,
    previousUpdates.length > 0
      ? `Updates during incident:\n${previousUpdates.map((u, i) => `  [${i + 1}] ${u}`).join('\n')}`
      : 'No updates were posted during the incident.',
    '',
    'Health history showing the incident arc:',
    formatHistory(ctx),
    '',
    'Write a resolution summary including likely root cause, duration, and lessons learned.',
  ].join('\n');
}
