# Scheduling Trees

TreeScheduler runs a behavior tree on a schedule -- once, at intervals, or on cron expressions.

```typescript
import { TreeScheduler } from 'cartographer';
```

---

## Constructor

```typescript
const scheduler = new TreeScheduler(config: SchedulerConfig);
```

### SchedulerConfig

```typescript
interface SchedulerConfig {
  tree: {
    tick(): Promise<NodeStatus>;
    reset(): void;
    readonly events: TypedEventEmitter<TreeEvents>;
  };
  schedule:
    | { type: 'cron'; expression: string }
    | { type: 'interval'; ms: number }
    | { type: 'once' };
  maxRuns?: number;
  stopOnStatus?: NodeStatus;
  resetBetweenTicks?: boolean; // default: true
  onError?: 'stop' | 'continue' | ((error: Error, runCount: number) => 'stop' | 'continue');
}
```

---

## Schedule Types

### Once

Ticks the tree a single time, then stops.

```typescript
const scheduler = new TreeScheduler({
  tree,
  schedule: { type: 'once' },
});
await scheduler.start();
// Tree ticks once, then scheduler stops with reason 'maxRuns'
```

### Interval

Waits `ms` milliseconds, ticks the tree, waits again, and repeats. The first tick happens after the initial delay, not immediately.

The loop is sequential: the scheduler awaits each tick to completion before starting the next wait period. Ticks never run concurrently. If a tick takes longer than `ms`, the effective period between tick *starts* is `ms + tickDuration` rather than a fixed `ms`. For example, with `ms: 10_000` and a tick that takes 25 seconds, ticks start 35 seconds apart:

```
t=0s    wait starts (10s)
t=10s   tick starts (takes 25s)
t=35s   tick finishes → wait starts (10s)
t=45s   tick starts
...
```

Think of `ms` as a minimum pause between ticks rather than a fixed period.

```typescript
const scheduler = new TreeScheduler({
  tree,
  schedule: { type: 'interval', ms: 30000 }, // 30s pause between ticks
});
await scheduler.start(); // Runs until stopped or maxRuns/stopOnStatus
```

### Cron

Uses cron expressions (parsed by `cron-parser`). The next occurrence is recomputed after each tick, so if a tick runs past the next scheduled slot, the scheduler advances to the following future occurrence rather than trying to "catch up" missed slots.

```typescript
const scheduler = new TreeScheduler({
  tree,
  schedule: { type: 'cron', expression: '*/5 * * * *' }, // Every 5 minutes
});
await scheduler.start();
```

---

## Configuration Options

### maxRuns

Stops after N ticks.

```typescript
{ maxRuns: 10 } // Stop after 10 ticks
```

### stopOnStatus

Stops when the tree returns a specific status.

```typescript
{ stopOnStatus: NodeStatus.SUCCESS } // Stop on first success
```

### resetBetweenTicks

Default: `true`. When enabled, calls `tree.reset()` before each tick (except the first). Set to `false` for stateful trees that should maintain state across ticks.

This setting is important for multi-tick workflows where nodes return `RUNNING`. When `resetBetweenTicks` is `false`, Sequence and Selector nodes remember which child was running and resume from that child on the next tick, skipping already-completed siblings. When `true`, the running child position is cleared and the composite starts from the beginning each tick.

### onError

Controls behavior when `tree.tick()` throws. Default: `'stop'`.

| Value | Behavior |
|-------|----------|
| `'stop'` | Emit `scheduler:stop` with reason `'error'`. |
| `'continue'` | Ignore the error and continue to the next tick. |
| Function | `(error, runCount) => 'stop' \| 'continue'` -- custom logic. |

```typescript
{
  onError: (error, runCount) => {
    console.error(`Tick ${runCount} failed: ${error.message}`);
    return runCount < 5 ? 'continue' : 'stop';
  },
}
```

---

## Scheduler Events

TreeScheduler has its own event emitter at `scheduler.events`.

```typescript
interface SchedulerEvents {
  'tick:start': { runCount: number; timestamp: Date };
  'tick:complete': { runCount: number; status: NodeStatus; durationMs: number };
  'tick:error': { runCount: number; error: Error };
  'scheduler:stop': { reason: 'manual' | 'maxRuns' | 'stopOnStatus' | 'error' };
}
```

---

## Lifecycle

- `scheduler.start()` -- begins the schedule loop. Returns a promise that resolves when the scheduler stops. No-op if already running.
- `scheduler.stop()` -- stops the scheduler. Clears timers and emits `scheduler:stop` with reason `'manual'`. No-op if not running.

### Read-only properties

| Property | Type | Description |
|----------|------|-------------|
| `isRunning` | `boolean` | Whether the scheduler is currently active. |
| `runCount` | `number` | Number of ticks completed so far. |
| `lastStatus` | `NodeStatus \| undefined` | Status returned by the most recent tick. |

---

## Example: Interval-Based Monitoring

```typescript
import { TreeBuilder, TreeScheduler, NodeStatus } from 'cartographer';

const tree = new TreeBuilder('health-check')
  .sequence('check', (b) => {
    b.action('ping-service', async (ctx) => {
      try {
        const res = await fetch(ctx.blackboard.get<string>('healthUrl')!);
        ctx.blackboard.set('healthy', res.ok);
        return res.ok ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
      } catch {
        ctx.blackboard.set('healthy', false);
        return NodeStatus.FAILURE;
      }
    });
    b.action('report-status', (ctx) => {
      const healthy = ctx.blackboard.get<boolean>('healthy');
      console.log(`Service is ${healthy ? 'UP' : 'DOWN'}`);
      return NodeStatus.SUCCESS;
    });
  })
  .build();

tree.blackboard.set('healthUrl', 'https://api.example.com/health');

const scheduler = new TreeScheduler({
  tree,
  schedule: { type: 'interval', ms: 60000 },
  onError: 'continue',
});

scheduler.events.on('tick:complete', ({ runCount, status, durationMs }) => {
  console.log(`Check #${runCount}: ${status} (${durationMs.toFixed(0)}ms)`);
});

scheduler.events.on('scheduler:stop', ({ reason }) => {
  console.log(`Scheduler stopped: ${reason}`);
});

// Start monitoring (runs until manually stopped)
scheduler.start();

// Later...
await scheduler.stop();
```

---

## Example: Multi-Tick Deploy Pipeline

This example demonstrates a long-running workflow that spans multiple scheduler ticks. The health check node returns `RUNNING` while waiting for the service to become healthy. Because `resetBetweenTicks` is `false`, the Sequence remembers that `start-deploy` already succeeded and resumes directly at `wait-for-healthy` on each subsequent tick.

```typescript
import { TreeBuilder, TreeScheduler, NodeStatus } from 'cartographer';

const tree = new TreeBuilder('deploy-pipeline')
  .sequence('deploy', (b) => {
    b.action('start-deploy', async (ctx) => {
      await triggerDeploy(ctx.blackboard.get<string>('service')!);
      return NodeStatus.SUCCESS;
    });

    b.action('wait-for-healthy', async (ctx) => {
      const healthy = await checkHealthEndpoint(ctx.blackboard.get<string>('service')!);
      return healthy ? NodeStatus.SUCCESS : NodeStatus.RUNNING;
    });

    b.action('notify-slack', async (ctx) => {
      await postToSlack('Deploy complete');
      return NodeStatus.SUCCESS;
    });
  })
  .build();

const scheduler = new TreeScheduler({
  tree,
  schedule: { type: 'interval', ms: 10_000 },
  resetBetweenTicks: false,           // preserve running child position
  stopOnStatus: NodeStatus.SUCCESS,   // stop when pipeline completes
});

scheduler.events.on('tick:complete', ({ runCount, status }) => {
  console.log(`Tick ${runCount}: ${status}`);
});

await scheduler.start();
```

Execution trace:

```
Tick 1: start-deploy → SUCCESS, wait-for-healthy → RUNNING (saved)
Tick 2: resume at wait-for-healthy → RUNNING
Tick 3: resume at wait-for-healthy → SUCCESS, notify-slack → SUCCESS
Tree returns SUCCESS, scheduler stops.
```

`start-deploy` runs exactly once. No idempotency guards are needed because the Sequence skips completed children when resuming.

---

## Where to go next

- [API Reference: TreeScheduler](api/scheduler.md) -- full type signatures and method details for TreeScheduler and related types.
- [API Reference Overview](api/index.md) -- all exports at a glance.
- [Scheduled Monitor Example](../examples/README.md#scheduled-monitor) -- a complete runnable program that uses `TreeScheduler` with `resetBetweenTicks: false` to monitor services, detect outages, and manage incidents across ticks.
