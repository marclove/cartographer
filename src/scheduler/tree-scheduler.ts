import { CronExpressionParser } from 'cron-parser';
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
  private currentTimerResolve?: () => void;
  private _stopEmitted = false;

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
    if (this._isRunning) return;
    this._isRunning = true;
    this.stopRequested = false;
    this._stopEmitted = false;

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
    if (!this._isRunning) return;
    this.stopRequested = true;
    if (this.currentTimer) {
      clearTimeout(this.currentTimer);
      this.currentTimer = undefined;
    }
    if (this.currentTimerResolve) {
      this.currentTimerResolve();
      this.currentTimerResolve = undefined;
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
      const parsed = CronExpressionParser.parse(expression);
      const next = parsed.next().toDate();
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
      this.currentTimerResolve = resolve;
      this.currentTimer = setTimeout(() => {
        this.currentTimerResolve = undefined;
        resolve();
      }, ms);
    });
  }

  private emitStop(reason: 'manual' | 'maxRuns' | 'stopOnStatus' | 'error'): void {
    if (this._stopEmitted) return;
    this._stopEmitted = true;
    this.events.emit('scheduler:stop', { reason });
  }
}
