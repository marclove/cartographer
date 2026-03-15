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
 * Increments the cycle counter. Placed at the end of the root sequence
 * so it only runs after all monitoring work succeeds, matching the
 * scheduler's and dashboard's completed-cycle semantics.
 */
export function incrementCycleCount(ctx: TreeContext): NodeStatus {
  const count = ctx.blackboard.get<number>('monitor:cycleCount') ?? 0;
  ctx.blackboard.set('monitor:cycleCount', count + 1);
  return NodeStatus.SUCCESS;
}

// --- Conditions ---

export function isUnhealthy(ctx: TreeContext): boolean {
  const assessment = ctx.blackboard.get<HealthAssessment>('assess-health:output');
  return assessment?.status === 'degraded' || assessment?.status === 'outage';
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
 * Guard condition: allows a status update only if enough cycles have
 * passed since the last update. Prevents flooding during sustained outages.
 */
export function enoughTimeSinceLastUpdate(ctx: TreeContext): boolean {
  const lastUpdateCycle = ctx.blackboard.get<number>('incident:lastUpdateCycle') ?? 0;
  const currentCycle = ctx.blackboard.get<number>('monitor:cycleCount') ?? 0;
  return currentCycle - lastUpdateCycle >= 3;
}

// --- Incident lifecycle actions ---

/**
 * Records the current cycle as part of an active incident.
 * Creates the incident on the first call; updates on subsequent calls.
 */
export function recordIncidentCycle(ctx: TreeContext): NodeStatus {
  const cycle = ctx.blackboard.get<number>('monitor:cycleCount') ?? 0;
  const assessment = ctx.blackboard.get<HealthAssessment>('assess-health:output');

  if (!ctx.blackboard.has('incident:startTime')) {
    ctx.blackboard.set('incident:startTime', new Date().toISOString());
    ctx.blackboard.set('incident:createdOnCycle', cycle);
    ctx.blackboard.set('incident:updates', []);
    console.log(`  [Cycle ${cycle}] Incident opened (assessment: ${assessment?.status})`);
  } else {
    console.log(`  [Cycle ${cycle}] Incident ongoing (assessment: ${assessment?.status})`);
  }

  // Track status update outputs for the prompt context.
  // Guard against re-consuming the same stale output on subsequent ticks by
  // comparing against the last accumulated update text.
  const statusUpdate = ctx.blackboard.get<{ update: string }>('draft-status-update:output');
  if (statusUpdate) {
    const updates = ctx.blackboard.get<string[]>('incident:updates') ?? [];
    const lastAccumulated = updates[updates.length - 1];
    if (statusUpdate.update !== lastAccumulated) {
      updates.push(statusUpdate.update);
      ctx.blackboard.set('incident:updates', updates);
      ctx.blackboard.set('incident:lastUpdateCycle', ctx.blackboard.get<number>('monitor:cycleCount') ?? 0);
    }
  }

  return NodeStatus.SUCCESS;
}

/**
 * Clears all incident state from the blackboard after recovery.
 */
export function clearIncidentState(ctx: TreeContext): NodeStatus {
  const cycle = ctx.blackboard.get<number>('monitor:cycleCount') ?? 0;
  console.log(`  [Cycle ${cycle}] Incident resolved`);
  ctx.blackboard.delete('incident:startTime');
  ctx.blackboard.delete('incident:createdOnCycle');
  ctx.blackboard.delete('incident:updates');
  ctx.blackboard.delete('incident:lastUpdateCycle');
  ctx.blackboard.delete('draft-incident-report:output');
  return NodeStatus.SUCCESS;
}

/**
 * Fallback action when no outage or recovery is active.
 * Logs the actual assessment status, which may be healthy or degraded.
 */
export function logHealthy(ctx: TreeContext): NodeStatus {
  const cycle = ctx.blackboard.get<number>('monitor:cycleCount') ?? 0;
  const assessment = ctx.blackboard.get<HealthAssessment>('assess-health:output');
  const status = assessment?.status ?? 'unknown';
  console.log(`  [Cycle ${cycle}] No incident (assessment: ${status})`);
  return NodeStatus.SUCCESS;
}
