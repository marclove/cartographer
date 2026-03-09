# Task 28: Scheduled Monitor — Actions, Tree, Entry Point, and Test

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the scheduled monitor example with health check actions, incident state management, the tree definition, the scheduler-based entry point, and a verification test.

**Architecture:** Actions manage the health check lifecycle: fetching endpoints, maintaining history, tracking incident state. The tree uses a parallel node for concurrent checks, a timeout-wrapped assessment agent, and a selector for graduated response. The entry point wires the tree to a `TreeScheduler` with `resetBetweenTicks: false` for stateful multi-tick execution. The test manually ticks the tree (no scheduler) to avoid timing dependencies.

**Tech Stack:** TypeScript, cartographer (TreeBuilder, TreeScheduler, NodeStatus), node:http

---

### Step 1: Create actions

Create `examples/scheduled-monitor/actions.ts`:

```typescript
import { NodeStatus } from '../../src/index.js';
import type { TreeContext } from '../../src/index.js';
import type { HealthAssessment, HealthRecord } from './schemas.js';

const SERVICES = ['api', 'database', 'queue'];
const HISTORY_WINDOW = 10;

/**
 * Creates a health check action for a specific service.
 * Always returns SUCCESS — the action records health data on the blackboard
 * rather than failing the tree on unhealthy responses.
 */
export function createHealthCheck(serviceName: string, baseUrl: string) {
  return async (ctx: TreeContext): Promise<NodeStatus> => {
    const start = Date.now();
    try {
      const res = await fetch(`${baseUrl}/${serviceName}`);
      const latencyMs = Date.now() - start;
      ctx.blackboard.set<HealthRecord>(`health:${serviceName}`, {
        healthy: res.ok,
        statusCode: res.status,
        latencyMs,
        timestamp: new Date().toISOString(),
      });
    } catch {
      ctx.blackboard.set<HealthRecord>(`health:${serviceName}`, {
        healthy: false,
        statusCode: 0,
        latencyMs: Date.now() - start,
        timestamp: new Date().toISOString(),
      });
    }
    return NodeStatus.SUCCESS;
  };
}

/**
 * Maintains a rolling window of health records per service.
 * Called after all health checks complete.
 */
export function updateHistory(ctx: TreeContext): NodeStatus {
  for (const service of SERVICES) {
    const current = ctx.blackboard.get<HealthRecord>(`health:${service}`);
    if (!current) continue;

    const historyKey = `history:${service}`;
    const history = ctx.blackboard.get<HealthRecord[]>(historyKey) ?? [];
    history.push(current);
    if (history.length > HISTORY_WINDOW) {
      history.shift();
    }
    ctx.blackboard.set(historyKey, history);
  }
  return NodeStatus.SUCCESS;
}

/**
 * Increments the tick counter. Used for throttling status updates.
 */
export function incrementTickCount(ctx: TreeContext): NodeStatus {
  const count = ctx.blackboard.get<number>('monitor:tickCount') ?? 0;
  ctx.blackboard.set('monitor:tickCount', count + 1);
  return NodeStatus.SUCCESS;
}

// --- Conditions ---

export function isOutage(ctx: TreeContext): boolean {
  const assessment = ctx.blackboard.get<HealthAssessment>('assess-health:output');
  return assessment?.status === 'outage';
}

export function wasDownNowHealthy(ctx: TreeContext): boolean {
  const assessment = ctx.blackboard.get<HealthAssessment>('assess-health:output');
  const hasActiveIncident = ctx.blackboard.has('incident:startTime');
  return assessment?.status === 'healthy' && hasActiveIncident;
}

export function noActiveIncident(ctx: TreeContext): boolean {
  return !ctx.blackboard.has('incident:startTime');
}

/**
 * Guard condition: allows a status update only if enough ticks have
 * passed since the last update. Prevents flooding during sustained outages.
 */
export function enoughTimeSinceLastUpdate(ctx: TreeContext): boolean {
  const lastUpdateTick = ctx.blackboard.get<number>('incident:lastUpdateTick') ?? 0;
  const currentTick = ctx.blackboard.get<number>('monitor:tickCount') ?? 0;
  return currentTick - lastUpdateTick >= 3;
}

// --- Incident lifecycle actions ---

/**
 * Records that the current tick is part of an active incident.
 * Creates the incident on the first call; updates on subsequent calls.
 */
export function recordIncidentTick(ctx: TreeContext): NodeStatus {
  if (!ctx.blackboard.has('incident:startTime')) {
    ctx.blackboard.set('incident:startTime', new Date().toISOString());
    ctx.blackboard.set('incident:updates', []);
  }

  // Track status update outputs for the prompt context
  const statusUpdate = ctx.blackboard.get<{ update: string }>('draft-status-update:output');
  if (statusUpdate) {
    const updates = ctx.blackboard.get<string[]>('incident:updates') ?? [];
    updates.push(statusUpdate.update);
    ctx.blackboard.set('incident:updates', updates);
    ctx.blackboard.set('incident:lastUpdateTick', ctx.blackboard.get<number>('monitor:tickCount') ?? 0);
  }

  return NodeStatus.SUCCESS;
}

/**
 * Clears all incident state from the blackboard after recovery.
 */
export function clearIncidentState(ctx: TreeContext): NodeStatus {
  ctx.blackboard.delete('incident:startTime');
  ctx.blackboard.delete('incident:updates');
  ctx.blackboard.delete('incident:lastUpdateTick');
  return NodeStatus.SUCCESS;
}

/**
 * Fallback action for healthy ticks. Logs a brief status line.
 */
export function logHealthy(ctx: TreeContext): NodeStatus {
  const tick = ctx.blackboard.get<number>('monitor:tickCount') ?? 0;
  console.log(`  [Tick ${tick}] All services healthy`);
  return NodeStatus.SUCCESS;
}
```

### Step 2: Create tree definition

Create `examples/scheduled-monitor/tree.ts`:

```typescript
import { TreeBuilder, NodeStatus } from '../../src/index.js';
import {
  HealthAssessmentSchema,
  IncidentReportSchema,
  StatusUpdateSchema,
  ResolutionSummarySchema,
} from './schemas.js';
import {
  assessHealthPrompt,
  draftIncidentReportPrompt,
  draftStatusUpdatePrompt,
  draftResolutionPrompt,
} from './prompts.js';
import {
  createHealthCheck,
  updateHistory,
  incrementTickCount,
  isOutage,
  wasDownNowHealthy,
  noActiveIncident,
  enoughTimeSinceLastUpdate,
  recordIncidentTick,
  clearIncidentState,
  logHealthy,
} from './actions.js';

/**
 * Builds the health monitor behavior tree.
 *
 * Tree structure:
 *   sequence "monitor"
 *   ├── action "increment-tick"
 *   ├── parallel "check-all-services"
 *   │   ├── action "check-api"
 *   │   ├── action "check-database"
 *   │   └── action "check-queue"
 *   ├── action "update-history"
 *   ├── alwaysSucceed → timeout(10s) → agent "assess-health" (structured, haiku)
 *   ├── selector "respond-to-assessment"
 *   │   ├── sequence "outage-path"
 *   │   │   ├── condition "is-outage"
 *   │   │   ├── selector "outage-actions"
 *   │   │   │   ├── sequence "new-outage"
 *   │   │   │   │   ├── condition "no-active-incident"
 *   │   │   │   │   └── agent "draft-incident-report" (structured, sonnet)
 *   │   │   │   ├── guard(enoughTimeSinceLastUpdate) → agent "draft-status-update" (structured, haiku)
 *   │   │   │   └── action "skip-update"
 *   │   │   └── action "record-incident-tick"
 *   │   ├── sequence "recovery-path"
 *   │   │   ├── condition "was-down-now-healthy"
 *   │   │   ├── agent "draft-resolution" (structured, sonnet)
 *   │   │   └── action "clear-incident"
 *   │   └── action "log-healthy"
 *
 * @param baseUrl Base URL of the test server (e.g. "http://localhost:3456")
 */
export function buildHealthMonitor(baseUrl: string) {
  return new TreeBuilder('health-monitor')
    .sequence('monitor', (b) => {
      b.action('increment-tick', incrementTickCount);

      // Check all services concurrently
      b.parallel('check-all-services', (b) => {
        b.action('check-api', createHealthCheck('api', baseUrl));
        b.action('check-database', createHealthCheck('database', baseUrl));
        b.action('check-queue', createHealthCheck('queue', baseUrl));
      });

      b.action('update-history', updateHistory);

      // AI health assessment with timeout fallback.
      // Wrapped in alwaysSucceed so the pipeline continues even
      // if the agent times out — stale assessment is better than
      // no response at all.
      b.alwaysSucceed('assess-with-fallback', (b) => {
        b.timeout('assess-timeout', { timeoutMs: 10_000 }, (b) => {
          b.agent('assess-health', {
            mode: 'structured',
            prompt: assessHealthPrompt,
            model: 'haiku',
            effort: 'low',
            outputSchema: HealthAssessmentSchema,
          });
        });
      });

      // Respond based on assessment
      b.selector('respond-to-assessment', (b) => {
        // Outage path
        b.sequence('outage-path', (b) => {
          b.condition('is-outage', isOutage);
          b.selector('outage-actions', (b) => {
            // New outage: draft initial incident report
            b.sequence('new-outage', (b) => {
              b.condition('no-active-incident', noActiveIncident);
              b.agent('draft-incident-report', {
                mode: 'structured',
                prompt: draftIncidentReportPrompt,
                model: 'sonnet',
                outputSchema: IncidentReportSchema,
              });
            });
            // Ongoing outage: periodic status update (throttled)
            b.guard('throttle-updates', { condition: enoughTimeSinceLastUpdate }, (b) => {
              b.agent('draft-status-update', {
                mode: 'structured',
                prompt: draftStatusUpdatePrompt,
                model: 'haiku',
                outputSchema: StatusUpdateSchema,
              });
            });
            // Fallback: no update needed this tick
            b.action('skip-update', () => NodeStatus.SUCCESS);
          });
          b.action('record-incident-tick', recordIncidentTick);
        });

        // Recovery path
        b.sequence('recovery-path', (b) => {
          b.condition('was-down-now-healthy', wasDownNowHealthy);
          b.agent('draft-resolution', {
            mode: 'structured',
            prompt: draftResolutionPrompt,
            model: 'sonnet',
            outputSchema: ResolutionSummarySchema,
          });
          b.action('clear-incident', clearIncidentState);
        });

        // Healthy fallback
        b.action('log-healthy', logHealthy);
      });
    })
    .build();
}
```

### Step 3: Create entry point

Create `examples/scheduled-monitor/index.ts`:

```typescript
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
```

### Step 4: Create test

Create `examples/scheduled-monitor/scheduled-monitor.test.ts`:

```typescript
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
```

### Step 5: Verify typecheck

Run: `npm run typecheck`
Expected: PASS

### Step 6: Run the example

Run: `npx tsx examples/scheduled-monitor/index.ts`
Expected: Prints tick-by-tick health dashboard with assessments. Takes ~2.5 minutes to complete 10 ticks. Shows healthy ticks, then outage detection with incident report, then recovery with resolution summary.

### Step 7: Run the test

Run: `npm run test:examples`
Expected: PASS (2 tests — content pipeline + scheduled monitor)

### Step 8: Commit

```bash
git add examples/scheduled-monitor/
git commit -m "feat(examples): add scheduled monitor example — multi-service health monitoring with incident lifecycle"
```
