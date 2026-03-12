import type { NodeStatus, SchedulerConfig } from '../types.js';
import type { BehaviorTree } from '../core/behavior-tree.js';

/**
 * Context provided by the CLI to the user's tree factory function.
 *
 * Contains environment variables (including any loaded from `--env-file`)
 * and positional arguments passed after the tree file path.
 *
 * @example
 * ```ts
 * // cartographer run my-tree.ts --env-file .env -- --target production
 * export default function(ctx: RunContext): TreeRunConfig {
 *   const target = ctx.args[0]; // '--target'
 *   const apiKey = ctx.env['API_KEY']; // from .env file
 *   // ...
 * }
 * ```
 */
export interface RunContext {
  /** Environment variables — `process.env` merged with `--env-file` values. */
  env: Record<string, string | undefined>;

  /** Positional arguments after the tree file path. */
  args: string[];
}

/**
 * Configuration returned by the user's tree factory function.
 *
 * At minimum, provide a `tree`. Optionally configure a schedule to run
 * the tree repeatedly, with stopping conditions and error handling.
 *
 * When `schedule` is omitted, the CLI runs the tree once via `tree.run()`.
 * When `schedule` is provided, the CLI wraps execution in a `TreeScheduler`.
 *
 * @example
 * ```ts
 * // Single run
 * export default function(ctx: RunContext): TreeRunConfig {
 *   return { tree: myBehaviorTree };
 * }
 *
 * // Scheduled — poll every 30 seconds, stop on success
 * export default function(ctx: RunContext): TreeRunConfig {
 *   return {
 *     tree: myBehaviorTree,
 *     schedule: { type: 'interval', delayMs: 30_000 },
 *     stopOnStatus: NodeStatus.SUCCESS,
 *   };
 * }
 * ```
 */
export interface TreeRunConfig {
  /** The constructed behavior tree to run. */
  tree: BehaviorTree;

  /** Optional schedule — omit for a single run. */
  schedule?: SchedulerConfig['schedule'];

  /** Maximum number of runs (only meaningful with a schedule). */
  maxRuns?: number;

  /** Stop scheduler when tree returns this status. */
  stopOnStatus?: NodeStatus;

  /** Whether to reset the tree between scheduled ticks. Defaults to `true`. */
  resetBetweenTicks?: boolean;

  /** Error handling policy for scheduled runs. */
  onError?: SchedulerConfig['onError'];
}
