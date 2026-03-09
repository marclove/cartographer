import { describe, it, expect, afterAll } from 'vitest';
import { NodeStatus } from '../../src/index.js';
import type { TreeEvents } from '../../src/index.js';
import { createTestServer, type TestServer } from './server.js';
import { buildHealthMonitor } from './tree.js';
import type { HealthRecord, HealthAssessment, IncidentReport } from './schemas.js';

describe('scheduled-monitor example', { timeout: 120_000 }, () => {
  let server: TestServer;

  afterAll(async () => {
    if (server) await server.close();
  });

  it('detects an api outage and opens an incident across multiple ticks', async () => {
    server = await createTestServer();
    const tree = buildHealthMonitor(server.url);

    // Track incident report via event listener — the blackboard key gets
    // deleted by clearIncidentState on recovery, so we can't check it after the run.
    let incidentReport: IncidentReport | undefined;
    tree.events.on('agent:response', (event: TreeEvents['agent:response']) => {
      if (event.node.name === 'draft-incident-report') {
        incidentReport = event.result as IncidentReport;
      }
    });

    // Tick 3 times manually (no scheduler, avoids timing dependencies).
    // Server failure profile for 'api':
    //   Request 1:   200 (healthy)
    //   Requests 2–4: 503 (hard outage)
    //   Requests 5+: 200 (recovered)
    // By tick 2 the assessment agent sees the 503 and classifies as degraded/outage,
    // triggering the incident report path.
    const TICK_COUNT = 3;
    const statuses: NodeStatus[] = [];
    for (let i = 0; i < TICK_COUNT; i++) {
      const status = await tree.tick();
      statuses.push(status);
    }

    // All ticks should complete without throwing
    expect(statuses).toHaveLength(TICK_COUNT);

    // Health data should be recorded for all services
    for (const service of ['api', 'database', 'queue']) {
      const health = tree.blackboard.get<HealthRecord>(`health:${service}`);
      expect(health).toBeDefined();
      expect(health!.statusCode).toBeTypeOf('number');
    }

    // History should accumulate across ticks
    const apiHistory = tree.blackboard.get<HealthRecord[]>('history:api');
    expect(apiHistory).toBeDefined();
    expect(apiHistory!.length).toBe(TICK_COUNT);

    // Requests 4+ to the api service return 503.
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

    // Tick count should be tracked
    expect(tree.blackboard.get<number>('monitor:tickCount')).toBe(TICK_COUNT);
  });
});
