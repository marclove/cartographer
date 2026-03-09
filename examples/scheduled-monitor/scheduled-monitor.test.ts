import { describe, it, expect, afterAll } from 'vitest';
import { NodeStatus } from '../../src/index.js';
import type { TreeEvents } from '../../src/index.js';
import { createTestServer, type TestServer } from './server.js';
import { buildHealthMonitor } from './tree.js';
import type { HealthRecord, HealthAssessment, IncidentReport } from './schemas.js';

describe('scheduled-monitor example', { timeout: 200_000 }, () => {
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
        incidentReport = event.output as IncidentReport;
      }
    });

    // Tick 9 times manually (no scheduler, avoids timing dependencies).
    // Server failure profile for 'api':
    //   Requests 1–3: 200 (healthy)
    //   Requests 4–6: 503 (hard outage — 3 consecutive failures)
    //   Requests 7+:  200 (recovered)
    // Three consecutive 503s give the assessment agent clear evidence of an outage.
    const statuses: NodeStatus[] = [];
    for (let i = 0; i < 9; i++) {
      const status = await tree.tick();
      statuses.push(status);
    }

    // All ticks should complete without throwing
    expect(statuses).toHaveLength(9);

    // Health data should be recorded for all services
    for (const service of ['api', 'database', 'queue']) {
      const health = tree.blackboard.get<HealthRecord>(`health:${service}`);
      expect(health).toBeDefined();
      expect(health!.statusCode).toBeTypeOf('number');
    }

    // History should accumulate across ticks (capped at HISTORY_WINDOW=10)
    const apiHistory = tree.blackboard.get<HealthRecord[]>('history:api');
    expect(apiHistory).toBeDefined();
    expect(apiHistory!.length).toBe(9);

    // Requests 4–6 to the api service return 503. At least 3 history records
    // should be unhealthy, confirming the health check captured the server failures.
    const unhealthyCount = apiHistory!.filter((r) => !r.healthy).length;
    expect(unhealthyCount).toBeGreaterThanOrEqual(3);

    // Assessment agent should have produced output on every tick
    const assessment = tree.blackboard.get<HealthAssessment>('assess-health:output');
    expect(assessment).toBeDefined();
    expect(['healthy', 'degraded', 'outage']).toContain(assessment!.status);

    // Three consecutive api failures should trigger the outage detection path
    // and cause the incident report agent to run.
    expect(incidentReport).toBeDefined();
    expect(['critical', 'major', 'minor']).toContain(incidentReport!.severity);

    // Tick count should be tracked
    expect(tree.blackboard.get<number>('monitor:tickCount')).toBe(9);
  });
});
