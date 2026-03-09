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

Waits `ms` milliseconds between each tick. The first tick happens after the initial delay, not immediately.

```typescript
const scheduler = new TreeScheduler({
  tree,
  schedule: { type: 'interval', ms: 30000 }, // Every 30 seconds
});
await scheduler.start(); // Runs until stopped or maxRuns/stopOnStatus
```

### Cron

Uses cron expressions (parsed by `cron-parser`).

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

## Where to go next

- [API Reference: TreeScheduler](api/scheduler.md) -- full type signatures and method details for TreeScheduler and related types.
- [API Reference Overview](api/index.md) -- all exports at a glance.
