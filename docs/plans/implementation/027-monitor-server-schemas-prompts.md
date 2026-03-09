# Task 27: Scheduled Monitor — Server, Schemas, and Prompts

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the local test server, Zod output schemas, and prompt functions for the scheduled health monitor example.

**Architecture:** The test server simulates three services (`api`, `database`, `queue`) with deterministic failure profiles driven by request count. Schemas define structured output for the assessment agent and incident management agents. Prompts inject blackboard state (health history, incident context) into agent instructions.

**Tech Stack:** TypeScript, node:http, zod/v4

---

### Step 1: Create the local test server

Create `examples/scheduled-monitor/server.ts`:

```typescript
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Creates a local HTTP server simulating three services with different
 * failure profiles. Each service tracks its own request count and
 * exhibits deterministic behavior:
 *
 * - /api      — Goes down (503) on requests 4–6, recovers after.
 * - /database — Gradually degrades (increasing latency) from request 7+.
 * - /queue    — Flaps (alternates 200/500) from request 5+.
 *
 * Deterministic profiles ensure the example produces interesting state
 * transitions: healthy → outage → recovery, with degradation and flapping
 * mixed in.
 */
export function createTestServer(): Promise<TestServer> {
  const requestCounts: Record<string, number> = {
    api: 0,
    database: 0,
    queue: 0,
  };

  const server = http.createServer((req, res) => {
    const service = req.url?.slice(1) ?? '';
    if (!(service in requestCounts)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown service' }));
      return;
    }

    requestCounts[service]++;
    const count = requestCounts[service];
    const { status, latency } = getServiceBehavior(service, count);

    setTimeout(() => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service,
        status: status === 200 ? 'ok' : 'error',
        requestCount: count,
      }));
    }, latency);
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        url: `http://localhost:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

function getServiceBehavior(
  service: string,
  requestCount: number,
): { status: number; latency: number } {
  switch (service) {
    case 'api':
      // Hard outage on requests 4–6
      if (requestCount >= 4 && requestCount <= 6) {
        return { status: 503, latency: 50 };
      }
      return { status: 200, latency: 20 };

    case 'database':
      // Gradual latency degradation from request 7+
      if (requestCount >= 7) {
        return { status: 200, latency: 200 + (requestCount - 7) * 100 };
      }
      return { status: 200, latency: 30 };

    case 'queue':
      // Flaps between up and down from request 5+
      if (requestCount >= 5 && requestCount % 2 === 0) {
        return { status: 500, latency: 10 };
      }
      return { status: 200, latency: 15 };

    default:
      return { status: 200, latency: 10 };
  }
}
```

### Step 2: Create schemas

Create `examples/scheduled-monitor/schemas.ts`:

```typescript
import { z } from 'zod/v4';

/**
 * Output schema for the health assessment agent.
 * The agent evaluates the full health history window and classifies
 * overall system status, considering patterns like gradual degradation,
 * flapping, and partial outages.
 */
export const HealthAssessmentSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'outage']),
  reasoning: z.string().describe('Brief explanation of the assessment'),
  affectedServices: z.array(z.string()).describe('Service names that are unhealthy or degraded'),
});

export type HealthAssessment = z.infer<typeof HealthAssessmentSchema>;

/**
 * Output schema for incident reports.
 * Produced when a new outage is detected (no active incident).
 */
export const IncidentReportSchema = z.object({
  title: z.string().describe('Short incident title'),
  severity: z.enum(['critical', 'major', 'minor']),
  summary: z.string().describe('Description of what is happening'),
  affectedServices: z.array(z.string()),
  recommendedActions: z.array(z.string()).describe('Immediate actions to take'),
});

export type IncidentReport = z.infer<typeof IncidentReportSchema>;

/**
 * Output schema for ongoing incident status updates.
 * Produced periodically during an active incident (throttled by guard).
 */
export const StatusUpdateSchema = z.object({
  update: z.string().describe('What has changed since the last update'),
  currentStatus: z.enum(['investigating', 'identified', 'monitoring', 'resolved']),
});

export type StatusUpdate = z.infer<typeof StatusUpdateSchema>;

/**
 * Output schema for resolution summaries.
 * Produced when an incident recovers (was down, now healthy).
 */
export const ResolutionSummarySchema = z.object({
  summary: z.string().describe('What happened and how it was resolved'),
  rootCause: z.string().describe('Likely root cause'),
  duration: z.string().describe('How long the incident lasted'),
  lessonsLearned: z.array(z.string()),
});

export type ResolutionSummary = z.infer<typeof ResolutionSummarySchema>;

/**
 * Shape of a single health check result stored on the blackboard.
 */
export interface HealthRecord {
  healthy: boolean;
  statusCode: number;
  latencyMs: number;
  timestamp: string;
}
```

### Step 3: Create prompts

Create `examples/scheduled-monitor/prompts.ts`:

```typescript
import type { TreeContext } from '../../src/index.js';
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
```

### Step 4: Verify typecheck

Run: `npm run typecheck`
Expected: PASS

### Step 5: Commit

```bash
git add examples/scheduled-monitor/server.ts examples/scheduled-monitor/schemas.ts examples/scheduled-monitor/prompts.ts
git commit -m "feat(examples): add scheduled monitor server, schemas, and prompts"
```
