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
    schedule: { type: 'interval', delayMs: 10_000 },
    resetBetweenTicks: false,
    maxRuns: 8,
    onError: 'continue',
  });

  console.log('=== Health Monitor (8 ticks, 10s interval) ===\n');

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

    // Print incident report only on the tick it was first created.
    // incident:createdOnTick is set by recordIncidentTick on first detection.
    const report = tree.blackboard.get<IncidentReport>('draft-incident-report:output');
    const createdOnTick = tree.blackboard.get<number>('incident:createdOnTick');
    if (report && createdOnTick === tick) {
      console.log(`\n  ** NEW INCIDENT: ${report.title} (${report.severity}) **`);
      console.log(`  ${report.summary}`);
      console.log(`  Actions: ${report.recommendedActions.join('; ')}`);
    }

    // Print status update only on the tick it was written.
    // incident:lastUpdateTick is set by recordIncidentTick when a new update is accumulated.
    const update = tree.blackboard.get<StatusUpdate>('draft-status-update:output');
    const lastUpdateTick = tree.blackboard.get<number>('incident:lastUpdateTick');
    if (update && lastUpdateTick === tick) {
      console.log(`\n  ** STATUS UPDATE: ${update.currentStatus} **`);
      console.log(`  ${update.update}`);
    }

    // Print resolution once when the incident clears. Delete the key after
    // displaying so it doesn't repeat on subsequent healthy ticks.
    const resolution = tree.blackboard.get<ResolutionSummary>('draft-resolution:output');
    if (resolution && !tree.blackboard.has('incident:startTime')) {
      console.log(`\n  ** RESOLVED **`);
      console.log(`  ${resolution.summary}`);
      console.log(`  Root cause: ${resolution.rootCause}`);
      console.log(`  Duration: ${resolution.duration}`);
      tree.blackboard.delete('draft-resolution:output');
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
