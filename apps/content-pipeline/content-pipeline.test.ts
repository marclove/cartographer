import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ActorServer } from 'cartographer';
import { buildContentPipeline } from './tree.js';
import { SAMPLE_TICKET } from './prompts.js';

let server: ActorServer;
let port: number;
const url = (path: string) => `http://localhost:${port}${path}`;

beforeAll(async () => {
  server = new ActorServer({
    createTree: () => buildContentPipeline(),
    sessionId: 'content-pipeline',
    port: 0,
  });
  ({ port } = await server.start());
});

afterAll(async () => {
  await server.stop();
});

async function pollBlackboard(key: string, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(url('/api/blackboard'));
    const bb = await res.json();
    if (bb[key] !== undefined) return bb;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for blackboard key: ${key}`);
}

describe('content-pipeline', { timeout: 120_500 }, () => {
  it('GET /api/tree returns the pipeline structure', async () => {
    const res = await fetch(url('/api/tree'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tree).toBe('triage-pipeline');
    expect(body.root.name).toBe('triage');
    expect(body.root.type).toBe('sequence');
  });

  it('GET /_platform/health returns ok', async () => {
    const res = await fetch(url('/_platform/health'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('processes a billing ticket end-to-end via the write endpoint', async () => {
    // Submit the ticket — writes to the blackboard and ticks the tree
    const writeRes = await fetch(url('/api/blackboard/ticket'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: SAMPLE_TICKET }),
    });
    expect(writeRes.status).toBe(202);
    const { id } = await writeRes.json();
    expect(id).toBeDefined();

    // Wait for the pipeline to complete by polling for the final output
    const bb = await pollBlackboard('triage:report');

    // Classification should route to billing
    const classification = bb['classify:output'] as Record<string, unknown>;
    expect(classification).toBeDefined();
    expect(classification.category).toBe('billing');
    expect(classification.urgency).toBeDefined();

    // Triage report should be consolidated with all pipeline outputs
    const report = bb['triage:report'] as Record<string, unknown>;
    expect(report).toBeDefined();
    expect(report.classification).toBeDefined();
    expect(report.response).toBeDefined();

    // Status should reflect completed processing
    const statusRes = await fetch(url('/api/status'));
    const status = await statusRes.json();
    expect(status.tree).toBe('triage-pipeline');
    expect(status.tickCount).toBeGreaterThan(0);
    expect(status.lastStatus).toBe('success');
  });
});
