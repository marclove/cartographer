import { NodeStatus, TreeScheduler } from '../../src/index.js';
import type { TreeEvents, SchedulerEvents } from '../../src/index.js';
import { createTestServer } from './server.js';
import { buildHealthMonitor } from './tree.js';
import type {
  HealthAssessment,
  HealthRecord,
  IncidentReport,
  StatusUpdate,
  ResolutionSummary,
} from './schemas.js';

const SERVICES = ['api', 'database', 'queue'];

async function main() {
  const server = await createTestServer();
  console.log(`Test server running on port ${server.port}\n`);

  const tree = buildHealthMonitor(server.url);

  // Track costs
  let totalCost = 0;
  tree.events.on('agent:response', (event: TreeEvents['agent:response']) => {
    if (event.cost !== undefined) {
      totalCost += event.cost;
    }
  });

  const scheduler = new TreeScheduler({
    tree,
    schedule: { type: 'interval', ms: 15_000 },
    resetBetweenTicks: false,
    maxRuns: 10,
    onError: 'continue',
  });

  console.log('=== Health Monitor (10 ticks, 15s interval) ===\n');

  // Track which ticks created new incidents (for display logic)
  const incidentCreatedOnTick = new Set<number>();
  function noActiveIncidentBefore(tick: number): boolean {
    if (incidentCreatedOnTick.has(tick)) return false;
    if (tree.blackboard.has('incident:startTime')) {
      incidentCreatedOnTick.add(tick);
      return true;
    }
    return false;
  }

  scheduler.events.on('tick:complete', (event: SchedulerEvents['tick:complete']) => {
    const tick = event.runCount;
    const assessment = tree.blackboard.get<HealthAssessment>('assess-health:output');

    // Print per-service health
    console.log(`[Tick ${tick}] ${event.status} (${event.durationMs.toFixed(0)}ms)`);
    for (const service of SERVICES) {
      const health = tree.blackboard.get<HealthRecord>(`health:${service}`);
      if (health) {
        console.log(`  ${service.padEnd(10)} ${health.statusCode} ${health.latencyMs}ms ${health.healthy ? 'OK' : 'FAIL'}`);
      }
    }

    // Print assessment
    if (assessment) {
      console.log(`  Assessment: ${assessment.status}`);
      if (assessment.affectedServices.length > 0) {
        console.log(`  Affected:   ${assessment.affectedServices.join(', ')}`);
      }
      console.log(`  Reasoning:  ${assessment.reasoning}`);
    }

    // Print incident report if just created
    const report = tree.blackboard.get<IncidentReport>('draft-incident-report:output');
    if (report && noActiveIncidentBefore(tick)) {
      console.log(`\n  ** NEW INCIDENT: ${report.title} (${report.severity}) **`);
      console.log(`  ${report.summary}`);
      console.log(`  Actions: ${report.recommendedActions.join('; ')}`);
    }

    // Print status update if posted
    const update = tree.blackboard.get<StatusUpdate>('draft-status-update:output');
    if (update) {
      console.log(`\n  ** STATUS UPDATE: ${update.currentStatus} **`);
      console.log(`  ${update.update}`);
    }

    // Print resolution if recovered
    const resolution = tree.blackboard.get<ResolutionSummary>('draft-resolution:output');
    if (resolution && !tree.blackboard.has('incident:startTime')) {
      console.log(`\n  ** RESOLVED **`);
      console.log(`  ${resolution.summary}`);
      console.log(`  Root cause: ${resolution.rootCause}`);
      console.log(`  Duration: ${resolution.duration}`);
    }

    console.log('');
  });

  scheduler.events.on('scheduler:stop', (event: SchedulerEvents['scheduler:stop']) => {
    console.log(`\nMonitor stopped: ${event.reason}`);
    console.log(`  Total ticks: ${scheduler.runCount}`);
    console.log(`  Total cost:  $${totalCost.toFixed(4)}`);
  });

  await scheduler.start();
  await server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
