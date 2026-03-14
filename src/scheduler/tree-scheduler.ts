import { CronExpressionParser } from 'cron-parser';
import { NodeStatus } from '../types.js';
import type { SchedulerConfig, SchedulerEvents } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';

/**
 * Runs a behavior tree on a repeating or one-shot schedule.
 *
 * `TreeScheduler` orchestrates tree ticks according to one of three schedule
 * types and stops automatically based on configurable conditions. Attach
 * listeners to {@link events} to observe tick timing, results, and errors.
 *
 * **Schedule types:**
 * - `'once'` — Tick the tree exactly one time, then stop.
 * - `'interval'` — Wait `delayMs` milliseconds, tick, wait again, repeat.
 *   The first tick occurs after the first wait (not immediately).
 * - `'cron'` — Parse a cron expression, wait until the next scheduled time,
 *   tick, then wait for the following occurrence.
 *
 * **Stopping conditions (checked in this order after each tick):**
 * 1. `stopOnStatus` — Stop when the tree returns a specific `NodeStatus`.
 * 2. `maxCycles` — Stop after a fixed number of completed cycles (terminal statuses).
 * 3. `onError` — Stop or continue when the tree throws. Default is `'stop'`.
 *
 * **Running a tree hourly and stopping on success:**
 * ```ts
 * const scheduler = new TreeScheduler({
 *   tree: myBehaviorTree,
 *   schedule: { type: 'cron', expression: '0 * * * *' },
 *   stopOnStatus: NodeStatus.SUCCESS,
 *   onError: 'continue',
 * });
 *
 * scheduler.events.on('tick:complete', ({ runCount, status, durationMs }) => {
 *   console.log(`Run #${runCount}: ${status} (${durationMs}ms)`);
 * });
 *
 * scheduler.events.on('scheduler:stop', ({ reason }) => {
 *   console.log(`Stopped: ${reason}`);
 * });
 *
 * await scheduler.start(); // resolves when the scheduler stops
 * ```
 *
 * **Polling every 5 seconds for up to 10 completed cycles:**
 * ```ts
 * const scheduler = new TreeScheduler({
 *   tree: myBehaviorTree,
 *   schedule: { type: 'interval', delayMs: 5_000 },
 *   maxCycles: 10,
 *   stopOnStatus: NodeStatus.SUCCESS,
 * });
 *
 * await scheduler.start();
 * console.log('Final status:', scheduler.lastStatus);
 * ```
 *
 * **Run once and await the result:**
 * ```ts
 * const scheduler = new TreeScheduler({
 *   tree: myBehaviorTree,
 *   schedule: { type: 'once' },
 * });
 *
 * await scheduler.start();
 * console.log('Status:', scheduler.lastStatus);
 * ```
 *
 * **Manual stop from outside:**
 * ```ts
 * scheduler.start(); // don't await — let it run in the background
 * await doSomeOtherWork();
 * await scheduler.stop(); // cancels the pending wait and emits scheduler:stop
 * ```
 */
export class TreeScheduler {
  /**
   * Event emitter for scheduler lifecycle events.
   *
   * Subscribe here to observe tick start/complete/error events and the
   * final stop event. See {@link SchedulerEvents} for the full list.
   */
  readonly events = new EventEmitter<SchedulerEvents>();

  private config: SchedulerConfig;

  /** Whether the scheduler loop is currently active. */
  private _isRunning = false;

  /** Total number of ticks executed since the last `start()` call. */
  private _runCount = 0;

  /** The `NodeStatus` returned by the most recent tick, if any. */
  private _lastStatus?: NodeStatus;

  /**
   * Number of completed cycles (ticks that returned a terminal status).
   * Only incremented when the tree returns SUCCESS or FAILURE, not RUNNING.
   */
  private _cycleCount = 0;

  /**
   * Set to `true` by `stop()` to signal the scheduler loop to exit
   * after the current (or next) tick completes.
   */
  private stopRequested = false;

  /** Whether a tick is currently executing (used by `skipOnOverlap`). */
  private _tickInProgress = false;

  /** Promise for the currently in-flight tick when `skipOnOverlap` is enabled. */
  private _inflightTick?: Promise<boolean>;

  /**
   * The active `setTimeout` handle for the current wait period.
   * Held so `stop()` can cancel it immediately.
   */
  private currentTimer?: ReturnType<typeof setTimeout>;

  /**
   * The resolve function of the active `waitMs` promise.
   * Held so `stop()` can resolve the promise early, unblocking the loop.
   */
  private currentTimerResolve?: () => void;

  /**
   * Guards against emitting `scheduler:stop` more than once if multiple
   * stop conditions are met simultaneously (e.g. `stopOnStatus` and
   * `maxCycles` both trigger on the same tick).
   */
  private _stopEmitted = false;

  constructor(config: SchedulerConfig) {
    this.config = config;
  }

  /** `true` while the scheduler loop is active, `false` otherwise. */
  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Total number of ticks executed since the last `start()` call.
   * Incremented before each tick, so it reflects the tick currently
   * in progress while `executeTick()` is running.
   */
  get runCount(): number {
    return this._runCount;
  }

  /**
   * Number of completed cycles since the last `start()` call.
   * A cycle completes when the tree returns a terminal status
   * (SUCCESS or FAILURE). RUNNING ticks do not increment this.
   */
  get cycleCount(): number {
    return this._cycleCount;
  }

  /**
   * The `NodeStatus` returned by the most recent completed tick.
   * `undefined` before the first tick has finished.
   */
  get lastStatus(): NodeStatus | undefined {
    return this._lastStatus;
  }

  /**
   * Start the scheduler and begin ticking the tree on the configured schedule.
   *
   * Returns a `Promise` that resolves when the scheduler stops — either
   * because a stopping condition was met (`maxCycles`, `stopOnStatus`, an
   * error with `onError: 'stop'`) or because `stop()` was called manually.
   *
   * Calling `start()` while the scheduler is already running is a no-op.
   * To restart, call `stop()` first and await it before calling `start()` again.
   */
  async start(): Promise<void> {
    if (this._isRunning) return;
    this._isRunning = true;
    this.stopRequested = false;
    this._stopEmitted = false;

    try {
      if (this.config.schedule.type === 'once') {
        await this.executeTick();
        // 'once' uses 'maxCycles' as the stop reason since it is semantically
        // equivalent to maxCycles: 1.
        this.emitStop('maxCycles');
      } else if (this.config.schedule.type === 'interval') {
        await this.runInterval(this.config.schedule.delayMs);
      } else if (this.config.schedule.type === 'cron') {
        await this.runCron(this.config.schedule.expression);
      }
    } finally {
      this._isRunning = false;
    }
  }

  /**
   * Request the scheduler to stop as soon as possible.
   *
   * If the scheduler is waiting between ticks, the wait is cancelled
   * immediately. If a tick is currently executing, the scheduler will stop
   * after it completes. Emits `scheduler:stop` with reason `'manual'`.
   *
   * Calling `stop()` when the scheduler is not running is a no-op.
   */
  async stop(): Promise<void> {
    if (!this._isRunning) return;
    this.stopRequested = true;
    if (this.currentTimer) {
      clearTimeout(this.currentTimer);
      this.currentTimer = undefined;
    }
    if (this.currentTimerResolve) {
      // Resolve the pending waitMs promise immediately so the loop unblocks.
      this.currentTimerResolve();
      this.currentTimerResolve = undefined;
    }
    // Wait for any in-flight tick to finish before aborting or emitting stop.
    // Without this, abortOnStop would yank tree state mid-tick, and callers
    // could call start() again while the old tick is still executing.
    if (this._inflightTick) {
      await this._inflightTick;
      this._inflightTick = undefined;
    }
    if (this.config.abortOnStop) {
      this.config.tree.abort?.();
    }
    this.emitStop('manual');
    this._isRunning = false;
  }

  /**
   * Loop that waits `delayMs` milliseconds before each tick.
   *
   * The first tick occurs after the first wait period — there is no
   * immediate tick at `t=0`. Continues until a stopping condition is
   * met or `stop()` is called.
   */
  private async runInterval(delayMs: number): Promise<void> {
    while (!this.stopRequested) {
      await this.waitMs(delayMs);

      if (this.stopRequested) break;

      if (this.config.skipOnOverlap) {
        if (this._tickInProgress) {
          this.config.tree.events.emit('tree:tick:skipped', { timestamp: Date.now() });
          continue;
        }
        // Fire tick without awaiting so the interval loop continues
        this._inflightTick = this.executeTick();
        // Handle the result asynchronously — stop the loop if needed
        this._inflightTick.then((shouldStop) => {
          if (shouldStop) this.stop();
        });
        continue;
      }

      this._inflightTick = this.executeTick();
      const shouldStop = await this._inflightTick;
      this._inflightTick = undefined;
      if (shouldStop) break;
    }

    // Wait for any in-flight tick to finish (skipOnOverlap path may have
    // a fire-and-forget tick still running when the loop exits).
    if (this._inflightTick) {
      await this._inflightTick;
      this._inflightTick = undefined;
    }
  }

  /**
   * Loop that parses the cron expression, waits until the next scheduled
   * occurrence, and ticks. Continues until a stopping condition is met
   * or `stop()` is called.
   *
   * The next occurrence is recomputed after each tick, so daylight-saving
   * transitions and variable-length months are handled correctly.
   */
  private async runCron(expression: string): Promise<void> {
    while (!this.stopRequested) {
      const parsed = CronExpressionParser.parse(expression);
      const next = parsed.next().toDate();
      const delayMs = next.getTime() - Date.now();

      if (delayMs > 0) {
        await this.waitMs(delayMs);
      }

      if (this.stopRequested) break;

      if (this.config.skipOnOverlap) {
        if (this._tickInProgress) {
          this.config.tree.events.emit('tree:tick:skipped', { timestamp: Date.now() });
          continue;
        }
        this._inflightTick = this.executeTick();
        this._inflightTick.then((shouldStop) => {
          if (shouldStop) this.stop();
        });
        continue;
      }

      this._inflightTick = this.executeTick();
      const shouldStop = await this._inflightTick;
      this._inflightTick = undefined;
      if (shouldStop) break;
    }

    if (this._inflightTick) {
      await this._inflightTick;
      this._inflightTick = undefined;
    }
  }

  /**
   * Execute one tree tick and evaluate stopping conditions.
   *
   * Returns `true` if the scheduler should stop after this tick, `false`
   * if it should continue. Stopping conditions are checked in this order:
   * 1. `stopOnStatus` — tree returned the configured terminal status.
   * 2. `maxCycles` — the cycle count has reached the configured limit.
   *
   * On error, the configured `onError` handler (default: `'stop'`) decides
   * whether to stop or continue. If continuing, `maxCycles` is still checked.
   *
   */
  private async executeTick(): Promise<boolean> {
    this._runCount++;
    const runCount = this._runCount;
    this._tickInProgress = true;
    try {
      this.events.emit('tick:start', { runCount, timestamp: new Date() });
      const start = performance.now();
      const status = await this.config.tree.tick();
      const durationMs = performance.now() - start;

      this._lastStatus = status;
      this.events.emit('tick:complete', { runCount, status, durationMs });

      // Increment cycle count only on terminal statuses (not RUNNING).
      if (status !== NodeStatus.RUNNING) {
        this._cycleCount++;
      }

      // Check stopOnStatus before maxCycles — a status match is a more specific
      // signal and should take precedence in the stop reason.
      if (this.config.stopOnStatus !== undefined && status === this.config.stopOnStatus) {
        this.emitStop('stopOnStatus');
        return true;
      }

      if (this.config.maxCycles !== undefined && this._cycleCount >= this.config.maxCycles) {
        this.emitStop('maxCycles');
        return true;
      }

      return false;
    } catch (error) {
      this.events.emit('tick:error', { runCount, error: error as Error });

      // Default is 'stop' — errors halt the scheduler unless explicitly configured otherwise.
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

      // Continuing after an error — still honour maxCycles.
      // Errors don't count as completed cycles, but if the cycle count
      // was already at the limit from a prior tick, stop now.
      if (this.config.maxCycles !== undefined && this._cycleCount >= this.config.maxCycles) {
        this.emitStop('maxCycles');
        return true;
      }

      return false;
    } finally {
      this._tickInProgress = false;
    }
  }

  /**
   * Return a promise that resolves after `ms` milliseconds.
   *
   * Stores the timer handle and resolve function so `stop()` can
   * cancel the wait and unblock the scheduler loop immediately.
   */
  private waitMs(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.currentTimerResolve = resolve;
      this.currentTimer = setTimeout(() => {
        this.currentTimerResolve = undefined;
        resolve();
      }, ms);
    });
  }

  /**
   * Emit a `scheduler:stop` event with the given reason.
   *
   * Guarded by `_stopEmitted` to ensure the event is emitted at most once,
   * even if multiple stopping conditions are met on the same tick.
   */
  private emitStop(reason: 'manual' | 'maxCycles' | 'stopOnStatus' | 'error'): void {
    if (this._stopEmitted) return;
    this._stopEmitted = true;
    this.events.emit('scheduler:stop', { reason });
  }
}
