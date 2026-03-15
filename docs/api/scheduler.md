# TreeScheduler

```typescript
import { TreeScheduler } from 'cartographer';
```

Constructor: `new TreeScheduler(config: SchedulerConfig)`

## SchedulerConfig

```typescript
interface SchedulerConfig {
  tree: { tick(): Promise<NodeStatus>; reset(): void; abort?(): void; readonly events: TypedEventEmitter<TreeEvents> };
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

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `tree` | `object` | Yes | — | Object with `tick()`, `reset()`, optional `abort()`, and `events` (typically a `BehaviorTree` instance) |
| `schedule` | `object` | Yes | — | Schedule type: `once`, `interval` (with `delayMs`), or `cron` (with `expression`) |
| `maxCycles` | `number` | No | — | Stop after N completed cycles (terminal statuses; RUNNING ticks do not count) |
| `stopOnStatus` | `NodeStatus` | No | — | Stop when tree returns this status |
| `skipOnOverlap` | `boolean` | No | `false` | Skip tick if previous tick is still in progress; emits `tree:tick:skipped` |
| `abortOnStop` | `boolean` | No | `false` | Call `tree.abort()` when the scheduler stops |
| `onError` | `string \| function` | No | `'stop'` | Error handling: `'stop'`, `'continue'`, or custom function |

## Properties (read-only)

- `events: EventEmitter<SchedulerEvents>` — Scheduler event emitter
- `isRunning: boolean` — Whether the scheduler is currently running
- `runCount: number` — Total ticks executed
- `cycleCount: number` — Number of completed cycles (terminal statuses)
- `lastStatus: NodeStatus | undefined` — Status from most recent tick

## Methods

- `start(): Promise<void>` — Start the schedule loop. Resolves when scheduler stops. No-op if already running.
- `stop(): Promise<void>` — Stop the scheduler. Awaits any in-flight tick, calls `tree.abort()` if `abortOnStop` is set, then emits `scheduler:stop` with reason `'manual'`. No-op if not running.

## SchedulerEvents

```typescript
interface SchedulerEvents {
  'tick:start': { runCount: number; timestamp: Date };
  'tick:complete': { runCount: number; status: NodeStatus; durationMs: number };
  'tick:error': { runCount: number; error: Error };
  'scheduler:stop': { reason: 'manual' | 'maxCycles' | 'stopOnStatus' | 'error' };
}
```

| Event | Payload | When |
|-------|---------|------|
| `tick:start` | `{ runCount, timestamp }` | Before each tick |
| `tick:complete` | `{ runCount, status, durationMs }` | After successful tick |
| `tick:error` | `{ runCount, error }` | When tick throws |
| `scheduler:stop` | `{ reason }` | When scheduler stops for any reason |

## Schedule Types

**Once:** Ticks once, stops with reason `'maxCycles'`.

```typescript
{ type: 'once' }
```

**Interval:** Waits `delayMs` milliseconds, then ticks. Repeats. First tick happens after initial delay.

```typescript
{ type: 'interval', delayMs: 60000 }
```

**Cron:** Uses cron expressions (via `cron-parser`). Waits until next cron time, then ticks.

```typescript
{ type: 'cron', expression: '*/5 * * * *' }
```

## Example

```typescript
import { TreeScheduler, NodeStatus } from 'cartographer';

const scheduler = new TreeScheduler({
  tree,
  schedule: { type: 'interval', delayMs: 5000 },
  maxCycles: 10,
  stopOnStatus: NodeStatus.FAILURE,
  onError: 'continue',
});

scheduler.events.on('tick:complete', ({ runCount, status }) => {
  console.log(`Tick ${runCount}: ${status}`);
});

scheduler.events.on('scheduler:stop', ({ reason }) => {
  console.log(`Stopped: ${reason}`);
});

await scheduler.start();
```
