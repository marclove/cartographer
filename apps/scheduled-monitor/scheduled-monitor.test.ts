import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ActorServer } from 'cartographer';
import { createTestServer, type TestServer } from './server.js';
import { buildHealthMonitor } from './tree.js';
import type { HealthRecord, HealthAssessment, IncidentReport } from './schemas.js';

let healthServer: TestServer;
let server: ActorServer;
let port: number;
const url = (path: string) => `http://localhost:${port}${path}`;

beforeAll(async () => {
  healthServer = await createTestServer();
  server = new ActorServer({
    createTree: () => buildHealthMonitor(healthServer.url),
    sessionId: 'health-monitor',
    port: 0,
  });
  ({ port } = await server.start());
});

afterAll(async () => {
  await server.stop();
  await healthServer.close();
});

async function sendTick(): Promise<void> {
  const res = await fetch(url('/api/messages'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'tick' }),
  });
  expect(res.status).toBe(202);
}

async function getBlackboard(): Promise<Record<string, unknown>> {
  const res = await fetch(url('/api/blackboard'));
  return res.json();
}

async function waitForCycle(n: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(url('/api/status'));
    const status = await res.json();
    if ((status.cycleCount as number) >= n) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for cycle ${n}`);
}

describe('scheduled-monitor', { timeout: 300_000 }, () => {
  it('GET /api/tree returns the monitor structure', async () => {
    const res = await fetch(url('/api/tree'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tree).toBe('health-monitor');
    expect(body.root.name).toBe('monitor');
    expect(body.root.type).toBe('sequence');
  });

  it('GET /_platform/health returns ok', async () => {
    const res = await fetch(url('/_platform/health'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('detects an outage and manages the incident lifecycle across ticks', async () => {
    // Server failure profile for 'api':
    //   Request 1:   200 (healthy)
    //   Requests 2-4: 503 (hard outage)
    //   Requests 5+:  200 (recovered)
    //
    // Each tick message runs one full monitoring cycle through the
    // HTTP interface. We capture the incident report between cycles
    // since recovery clears it from the blackboard.
    const TARGET_CYCLES = 5;
    let incidentReport: IncidentReport | undefined;

    for (let i = 1; i <= TARGET_CYCLES; i++) {
      await sendTick();
      await waitForCycle(i);

      // Capture the incident report before recovery clears it
      if (!incidentReport) {
        const bb = await getBlackboard();
        incidentReport = bb['draft-incident-report:output'] as IncidentReport | undefined;
      }
    }

    const bb = await getBlackboard();

    // Health data should be recorded for all services
    for (const service of ['api', 'database', 'queue']) {
      const health = bb[`health:${service}`] as HealthRecord;
      expect(health).toBeDefined();
      expect(health.statusCode).toBeTypeOf('number');
    }

    // History should accumulate across cycles
    const apiHistory = bb['history:api'] as HealthRecord[];
    expect(apiHistory).toBeDefined();
    expect(apiHistory.length).toBeGreaterThanOrEqual(TARGET_CYCLES);

    // At least 1 unhealthy record (requests 2-4 return 503)
    const unhealthyCount = apiHistory.filter((r) => !r.healthy).length;
    expect(unhealthyCount).toBeGreaterThanOrEqual(1);

    // Assessment agent should have produced output
    const assessment = bb['assess-health:output'] as HealthAssessment;
    expect(assessment).toBeDefined();
    expect(['healthy', 'degraded', 'outage']).toContain(assessment.status);

    // An incident report should have been produced during the outage
    expect(incidentReport).toBeDefined();
    expect(['critical', 'major', 'minor']).toContain(incidentReport!.severity);

    // Status endpoint should reflect completed cycles
    const statusRes = await fetch(url('/api/status'));
    const status = await statusRes.json();
    expect(status.tree).toBe('health-monitor');
    expect(status.cycleCount as number).toBeGreaterThanOrEqual(TARGET_CYCLES);
    expect(status.lastStatus).toBe('success');
  });
});
