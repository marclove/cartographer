import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { NodeStatus, createTreeLogger } from '../../src/index.js';
import type { TreeEvents } from '../../src/index.js';
import { createTestServer, type TestServer } from './server.js';
import { buildHealthMonitor } from './tree.js';
import type { HealthRecord, HealthAssessment, IncidentReport } from './schemas.js';

const LOG_FILE = 'logs/scheduled-monitor.log';

let stopLogging: (() => void) | undefined;
afterEach(() => { stopLogging?.(); stopLogging = undefined; });

describe('scheduled-monitor example', { timeout: 300_000 }, () => {
  let server: TestServer;

  afterAll(async () => {
    if (server) await server.close();
  });

  it('detects an api outage and opens an incident across multiple ticks', async () => {
    server = await createTestServer();
    const tree = buildHealthMonitor(server.url);
    stopLogging = createTreeLogger(tree.events, { filePath: LOG_FILE, logBlackboard: true });

    // Track incident report via event listener — the blackboard key gets
    // deleted by clearIncidentState on recovery, so we can't check it after the run.
    let incidentReport: IncidentReport | undefined;
    tree.events.on('agent:response', (event: TreeEvents['agent:response']) => {
      if (event.node.name === 'draft-incident-report') {
        incidentReport = event.result as IncidentReport;
      }
    });

    // With the inflight pattern, each ActionNode and AgentNode returns RUNNING
    // on first tick, then SUCCESS/FAILURE on the next tick after the work
    // completes. A single logical monitoring cycle therefore requires many more
    // raw ticks than before. We tick until 4 complete monitoring cycles have
    // run (tracked by monitor:tickCount on the blackboard), with a generous
    // ceiling to avoid infinite loops and short sleeps between ticks to let
    // async work (HTTP fetches, agent API calls) settle.
    //
    // Server failure profile for 'api':
    //   Request 1:   200 (healthy)
    //   Requests 2–4: 503 (hard outage)
    //   Requests 5+:  200 (recovered)
    // This exercises the full incident lifecycle: healthy baseline → outage
    // detection → ongoing incident → potential recovery.
    const TARGET_CYCLES = 4;
    const MAX_TICKS = 2000;
    let totalTicks = 0;

    while (
      (tree.blackboard.get<number>('monitor:tickCount') ?? 0) < TARGET_CYCLES &&
      totalTicks < MAX_TICKS
    ) {
      await tree.tick();
      totalTicks++;
      // Short pause: lets microtask-resolved promises (sync actions) settle
      // and gives the agent API calls time to make progress between polls.
      await new Promise(r => setTimeout(r, 50));
    }

    // Should have reached the target number of complete monitoring cycles
    const completedCycles = tree.blackboard.get<number>('monitor:tickCount') ?? 0;
    expect(completedCycles).toBeGreaterThanOrEqual(TARGET_CYCLES);

    // Health data should be recorded for all services
    for (const service of ['api', 'database', 'queue']) {
      const health = tree.blackboard.get<HealthRecord>(`health:${service}`);
      expect(health).toBeDefined();
      expect(health!.statusCode).toBeTypeOf('number');
    }

    // History should accumulate across completed cycles
    const apiHistory = tree.blackboard.get<HealthRecord[]>('history:api');
    expect(apiHistory).toBeDefined();
    expect(apiHistory!.length).toBeGreaterThanOrEqual(TARGET_CYCLES);

    // Requests 2–4 to the api service return 503.
    const unhealthyCount = apiHistory!.filter((r) => !r.healthy).length;
    expect(unhealthyCount).toBeGreaterThanOrEqual(1);

    // Assessment agent should have produced output
    const assessment = tree.blackboard.get<HealthAssessment>('assess-health:output');
    expect(assessment).toBeDefined();
    expect(['healthy', 'degraded', 'outage']).toContain(assessment!.status);

    // The api failure should trigger the incident detection path
    // and cause the incident report agent to run.
    expect(incidentReport).toBeDefined();
    expect(['critical', 'major', 'minor']).toContain(incidentReport!.severity);
  });
});
