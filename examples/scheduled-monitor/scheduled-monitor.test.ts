import { describe, it, expect, afterAll } from 'vitest';
import { NodeStatus } from '../../src/index.js';
import { createTestServer, type TestServer } from './server.js';
import { buildHealthMonitor } from './tree.js';
import type { HealthRecord, HealthAssessment } from './schemas.js';

describe('scheduled-monitor example', { timeout: 120_000 }, () => {
  let server: TestServer;

  afterAll(async () => {
    if (server) await server.close();
  });

  it('checks services and produces health assessments across multiple ticks', async () => {
    server = await createTestServer();
    const tree = buildHealthMonitor(server.url);

    // Tick 5 times manually (no scheduler, avoids timing dependencies).
    // Ticks 1–3: all services healthy.
    // Tick 4+: API goes down, triggering outage detection.
    const statuses: NodeStatus[] = [];
    for (let i = 0; i < 5; i++) {
      const status = await tree.tick();
      statuses.push(status);
    }

    // All ticks should complete (SUCCESS or FAILURE, not throw)
    expect(statuses).toHaveLength(5);

    // Health data should be recorded for all services
    for (const service of ['api', 'database', 'queue']) {
      const health = tree.blackboard.get<HealthRecord>(`health:${service}`);
      expect(health).toBeDefined();
      expect(health!.statusCode).toBeTypeOf('number');
    }

    // History should accumulate across ticks
    const apiHistory = tree.blackboard.get<HealthRecord[]>('history:api');
    expect(apiHistory).toBeDefined();
    expect(apiHistory!.length).toBe(5);

    // Assessment agent should have produced output
    const assessment = tree.blackboard.get<HealthAssessment>('assess-health:output');
    expect(assessment).toBeDefined();
    expect(['healthy', 'degraded', 'outage']).toContain(assessment!.status);

    // Tick count should be tracked
    expect(tree.blackboard.get<number>('monitor:tickCount')).toBe(5);
  });
});
