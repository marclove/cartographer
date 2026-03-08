# Task 16: Tree Scheduler

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the `TreeScheduler` that runs a behavior tree on a CRON expression, fixed interval, or once.

**Architecture:** The scheduler is a thin orchestrator. It calls `tree.tick()` on a schedule, manages the lifecycle (start/stop/maxRuns/stopOnStatus), and emits its own events. It uses `cron-parser` to compute the next execution time for CRON schedules.

**Tech Stack:** TypeScript, cron-parser

---

### Step 1: Write failing tests

Create `src/scheduler/tree-scheduler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TreeScheduler } from './tree-scheduler.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';

function createTree(status: NodeStatus | (() => NodeStatus)): BehaviorTree {
  const fn = typeof status === 'function' ? status : () => status;
  return new BehaviorTree({
    name: 'test-tree',
    root: new ActionNode({ name: 'root', action: fn }),
  });
}

describe('TreeScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once with schedule type "once"', async () => {
    const tree = createTree(NodeStatus.SUCCESS);
    const tickSpy = vi.spyOn(tree, 'tick');

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'once' },
    });

    await scheduler.start();

    expect(tickSpy).toHaveBeenCalledOnce();
    expect(scheduler.runCount).toBe(1);
    expect(scheduler.isRunning).toBe(false);
  });

  it('runs on interval and stops manually', async () => {
    const tree = createTree(NodeStatus.SUCCESS);
    const tickSpy = vi.spyOn(tree, 'tick');

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', ms: 100 },
    });

    const startPromise = scheduler.start();

    // Advance through 3 intervals
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    await scheduler.stop();
    await startPromise;

    expect(tickSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(scheduler.isRunning).toBe(false);
  });

  it('stops after maxRuns', async () => {
    const tree = createTree(NodeStatus.SUCCESS);

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', ms: 50 },
      maxRuns: 3,
    });

    const startPromise = scheduler.start();

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50); // extra to ensure it stops

    await startPromise;

    expect(scheduler.runCount).toBe(3);
    expect(scheduler.isRunning).toBe(false);
  });

  it('stops when stopOnStatus is reached', async () => {
    let callCount = 0;
    const tree = createTree(() => {
      callCount++;
      return callCount >= 2 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
    });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', ms: 50 },
      stopOnStatus: NodeStatus.SUCCESS,
    });

    const startPromise = scheduler.start();

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);

    await startPromise;

    expect(scheduler.lastStatus).toBe(NodeStatus.SUCCESS);
    expect(scheduler.isRunning).toBe(false);
  });

  it('emits tick:start and tick:complete events', async () => {
    const tree = createTree(NodeStatus.SUCCESS);
    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'once' },
    });

    const startSpy = vi.fn();
    const completeSpy = vi.fn();
    scheduler.events.on('tick:start', startSpy);
    scheduler.events.on('tick:complete', completeSpy);

    await scheduler.start();

    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ runCount: 1 }),
    );
    expect(completeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ runCount: 1, status: NodeStatus.SUCCESS }),
    );
  });

  it('emits scheduler:stop event', async () => {
    const tree = createTree(NodeStatus.SUCCESS);
    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'once' },
    });

    const stopSpy = vi.fn();
    scheduler.events.on('scheduler:stop', stopSpy);

    await scheduler.start();

    expect(stopSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'maxRuns' }),
    );
  });

  it('resets tree between ticks by default', async () => {
    const tree = createTree(NodeStatus.SUCCESS);
    const resetSpy = vi.spyOn(tree, 'reset');

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', ms: 50 },
      maxRuns: 2,
    });

    const startPromise = scheduler.start();
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await startPromise;

    // Reset is called before each tick after the first
    expect(resetSpy).toHaveBeenCalled();
  });

  it('does not reset tree when resetBetweenTicks is false', async () => {
    const tree = createTree(NodeStatus.SUCCESS);
    const resetSpy = vi.spyOn(tree, 'reset');

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', ms: 50 },
      maxRuns: 2,
      resetBetweenTicks: false,
    });

    const startPromise = scheduler.start();
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await startPromise;

    expect(resetSpy).not.toHaveBeenCalled();
  });

  it('continues on error when onError is "continue"', async () => {
    let callCount = 0;
    const tree = createTree(() => {
      callCount++;
      if (callCount === 1) throw new Error('boom');
      return NodeStatus.SUCCESS;
    });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', ms: 50 },
      maxRuns: 2,
      onError: 'continue',
    });

    const errorSpy = vi.fn();
    scheduler.events.on('tick:error', errorSpy);

    const startPromise = scheduler.start();
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await startPromise;

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(scheduler.runCount).toBe(2);
  });

  it('stops on error when onError is "stop"', async () => {
    const tree = createTree(() => { throw new Error('boom'); });

    const scheduler = new TreeScheduler({
      tree,
      schedule: { type: 'interval', ms: 50 },
      onError: 'stop',
    });

    const stopSpy = vi.fn();
    scheduler.events.on('scheduler:stop', stopSpy);

    const startPromise = scheduler.start();
    await vi.advanceTimersByTimeAsync(50);
    await startPromise;

    expect(stopSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'error' }),
    );
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/scheduler/tree-scheduler.test.ts`
Expected: FAIL

### Step 3: Implement TreeScheduler

Create `src/scheduler/tree-scheduler.ts`:

```typescript
import { parseExpression } from 'cron-parser';
import { NodeStatus } from '../types.js';
import type { SchedulerConfig, SchedulerEvents } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';

export class TreeScheduler {
  readonly events = new EventEmitter<SchedulerEvents>();

  private config: SchedulerConfig;
  private _isRunning = false;
  private _runCount = 0;
  private _lastStatus?: NodeStatus;
  private stopRequested = false;
  private currentTimer?: ReturnType<typeof setTimeout>;

  constructor(config: SchedulerConfig) {
    this.config = config;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get runCount(): number {
    return this._runCount;
  }

  get lastStatus(): NodeStatus | undefined {
    return this._lastStatus;
  }

  async start(): Promise<void> {
    this._isRunning = true;
    this.stopRequested = false;

    try {
      if (this.config.schedule.type === 'once') {
        await this.executeTick();
        this.emitStop('maxRuns');
      } else if (this.config.schedule.type === 'interval') {
        await this.runInterval(this.config.schedule.ms);
      } else if (this.config.schedule.type === 'cron') {
        await this.runCron(this.config.schedule.expression);
      }
    } finally {
      this._isRunning = false;
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.currentTimer) {
      clearTimeout(this.currentTimer);
      this.currentTimer = undefined;
    }
    this.emitStop('manual');
    this._isRunning = false;
  }

  private async runInterval(ms: number): Promise<void> {
    while (!this.stopRequested) {
      await this.waitMs(ms);

      if (this.stopRequested) break;

      const shouldStop = await this.executeTick();
      if (shouldStop) break;
    }
  }

  private async runCron(expression: string): Promise<void> {
    while (!this.stopRequested) {
      const interval = parseExpression(expression);
      const next = interval.next().toDate();
      const delayMs = next.getTime() - Date.now();

      if (delayMs > 0) {
        await this.waitMs(delayMs);
      }

      if (this.stopRequested) break;

      const shouldStop = await this.executeTick();
      if (shouldStop) break;
    }
  }

  private async executeTick(): Promise<boolean> {
    const resetBetweenTicks = this.config.resetBetweenTicks ?? true;

    if (this._runCount > 0 && resetBetweenTicks) {
      this.config.tree.reset();
    }

    this._runCount++;
    const runCount = this._runCount;

    this.events.emit('tick:start', { runCount, timestamp: new Date() });
    const start = performance.now();

    try {
      const status = await this.config.tree.tick();
      const durationMs = performance.now() - start;

      this._lastStatus = status;
      this.events.emit('tick:complete', { runCount, status, durationMs });

      if (this.config.stopOnStatus !== undefined && status === this.config.stopOnStatus) {
        this.emitStop('stopOnStatus');
        return true;
      }

      if (this.config.maxRuns !== undefined && this._runCount >= this.config.maxRuns) {
        this.emitStop('maxRuns');
        return true;
      }

      return false;
    } catch (error) {
      this.events.emit('tick:error', { runCount, error: error as Error });

      const onError = this.config.onError ?? 'stop';
      let decision: 'stop' | 'continue';

      if (typeof onError === 'function') {
        decision = onError(error as Error, runCount);
      } else {
        decision = onError;
      }

      if (decision === 'stop') {
        this.emitStop('error');
        return true;
      }

      // continue — check maxRuns
      if (this.config.maxRuns !== undefined && this._runCount >= this.config.maxRuns) {
        this.emitStop('maxRuns');
        return true;
      }

      return false;
    }
  }

  private waitMs(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.currentTimer = setTimeout(resolve, ms);
    });
  }

  private emitStop(reason: 'manual' | 'maxRuns' | 'stopOnStatus' | 'error'): void {
    this.events.emit('scheduler:stop', { reason });
  }
}
```

### Step 4: Run test to verify it passes

Run: `npx vitest run src/scheduler/tree-scheduler.test.ts`
Expected: PASS (all 10 tests)

### Step 5: Commit

```bash
git add src/scheduler/tree-scheduler.ts src/scheduler/tree-scheduler.test.ts
git commit -m "feat: implement TreeScheduler with interval, cron, and once scheduling"
```
