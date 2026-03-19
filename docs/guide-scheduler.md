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
    abort?(): void;
    readonly events: TypedEventEmitter<TreeEvents>;
  };
  schedule:
    | { type: 'cron'; expression: string }
    | { type: 'interval'; delayMs: number }
    | { type: 'once' };
  maxCycles?: number;
  stopOnStatus?: NodeStatus;
  skipOnOverlap?: boolean;
  abortOnStop?: boolean;
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
// Tree ticks once, then scheduler stops with reason 'maxCycles'
```

### Interval

Waits `delayMs` milliseconds, ticks the tree, waits again, and repeats. The first tick happens after the initial delay, not immediately.

By default, the loop is sequential: the scheduler awaits each tick to completion before starting the next wait period. If a tick takes longer than `delayMs`, the effective period between tick *starts* is `delayMs + tickDuration` rather than a fixed `delayMs`. When `skipOnOverlap: true`, ticks fire on schedule but are skipped if the previous tick is still in progress, emitting a `tree:tick:skipped` event instead. For example, with `delayMs: 10_000` and a tick that takes 25 seconds, ticks start 35 seconds apart (without overlap skipping):

```
t=0s    wait starts (10s)
t=10s   tick starts (takes 25s)
t=35s   tick finishes → wait starts (10s)
t=45s   tick starts
...
```

Think of `delayMs` as a minimum pause between ticks rather than a fixed period.

```typescript
const scheduler = new TreeScheduler({
  tree,
  schedule: { type: 'interval', delayMs: 30000 }, // 30s pause between ticks
});
await scheduler.start(); // Runs until stopped or maxCycles/stopOnStatus
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

### maxCycles

Stops after N completed cycles. A cycle completes when the tree returns a terminal status (SUCCESS or FAILURE). RUNNING ticks do not increment the counter.

```typescript
{ maxCycles: 10 } // Stop after 10 completed cycles
```

### stopOnStatus

Stops when the tree returns a specific status.

```typescript
{ stopOnStatus: NodeStatus.SUCCESS } // Stop on first success
```

### skipOnOverlap

When `true`, if a tick is still in progress when the next interval/cron fires, the tick is skipped and a `tree:tick:skipped` event is emitted on the tree's event emitter. Defaults to `false`.

```typescript
{ skipOnOverlap: true } // Skip ticks that overlap with a running tick
```

### abortOnStop

When `true`, calls `tree.abort()` after in-flight ticks complete when the scheduler stops. Defaults to `false`.

```typescript
{ abortOnStop: true } // Abort tree state when stopping
```

### onError

Controls behavior when `tree.tick()` throws. Default: `'stop'`.

| Value | Behavior |
|-------|----------|
| `'stop'` | Emit `scheduler:stop` with reason `'error'`. |
| `'continue'` | Ignore the error and continue to the next tick. |
| Function | `(error, cycleCount) => 'stop' \| 'continue'` -- custom logic. |

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
  'scheduler:stop': { reason: 'manual' | 'maxCycles' | 'stopOnStatus' | 'error' };
}
```

---

## Lifecycle

- `scheduler.start()` -- begins the schedule loop. Returns a promise that resolves when the scheduler stops. No-op if already running.
- `scheduler.stop()` -- stops the scheduler. Awaits any in-flight tick before resolving, then calls `tree.abort()` if `abortOnStop` is set. Emits `scheduler:stop` with reason `'manual'`. No-op if not running.

### Read-only properties

| Property | Type | Description |
|----------|------|-------------|
| `isRunning` | `boolean` | Whether the scheduler is currently active. |
| `runCount` | `number` | Number of ticks completed so far. |
| `cycleCount` | `number` | Number of completed cycles (terminal statuses). |
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
  schedule: { type: 'interval', delayMs: 60000 },
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

This example demonstrates a long-running workflow that spans multiple scheduler ticks. The deploy action uses the inflight pattern to launch work on the first tick and poll on subsequent ticks. The sequence re-evaluates from child 0 on every tick but uses cached results for non-reactive children that already completed.

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
  schedule: { type: 'interval', delayMs: 10_000 },
  stopOnStatus: NodeStatus.SUCCESS,   // stop when pipeline completes
});

scheduler.events.on('tick:complete', ({ runCount, status }) => {
  console.log(`Tick ${runCount}: ${status}`);
});

await scheduler.start();
```

Execution trace:

```
Tick 1: start-deploy → RUNNING (inflight, action launched)
Tick 2: start-deploy → SUCCESS (cached), wait-for-healthy → RUNNING
Tick 3: start-deploy → SUCCESS (cached), wait-for-healthy → RUNNING
Tick 4: start-deploy → SUCCESS (cached), wait-for-healthy → SUCCESS, notify-slack → RUNNING
Tick 5: start-deploy → SUCCESS (cached), wait-for-healthy → SUCCESS (cached), notify-slack → SUCCESS
Tree returns SUCCESS, scheduler stops.
```

`start-deploy` runs exactly once because the sequence caches its non-reactive terminal result. Conditions placed before actions would be re-evaluated on every tick, enabling preemption if circumstances change.

---

## BehaviorTree.start()

For convenience, `BehaviorTree` provides a `start()` method that creates a scheduler internally with reactive-friendly defaults (`skipOnOverlap: true`, `abortOnStop: true`).

```typescript
import { BehaviorTree } from 'cartographer';

const handle = tree.start({ intervalMs: 100 });

// Optionally pass an AbortSignal
const controller = new AbortController();
const handle = tree.start({ intervalMs: 100, signal: controller.signal });

// Stop the tick loop
await handle.stop();
```

**Signature:** `start(options: { intervalMs: number; signal?: AbortSignal }): TickLoopHandle`

The returned `TickLoopHandle` has a single method: `stop(): Promise<void>`, which stops the loop and waits for any in-flight tick to complete.

---

## Where to go next

- [API Reference: TreeScheduler](api/scheduler.md) -- full type signatures and method details for TreeScheduler and related types.
- [API Reference Overview](api/index.md) -- all exports at a glance.
- [Scheduled Monitor Example](../apps/scheduled-monitor/) -- a complete runnable program that uses `TreeScheduler` to monitor services, detect outages, and manage incidents across ticks.
- [CLI Runner](guide-cli.md) -- run scheduled trees from the command line with `cartographer run`.
