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
 * Provide a `tree` and a `sessionId`. The CLI starts an ActorServer
 * for the tree. When `autoTick` is set, the server automatically
 * sends tick messages at the configured interval.
 *
 * @example
 * ```ts
 * export default function(ctx: RunContext): TreeRunConfig {
 *   return { tree: myBehaviorTree, sessionId: 'main' };
 * }
 *
 * // With auto-tick — tick every 5 seconds
 * export default function(ctx: RunContext): TreeRunConfig {
 *   return {
 *     tree: myBehaviorTree,
 *     sessionId: 'main',
 *     autoTick: { intervalMs: 5_000 },
 *   };
 * }
 * ```
 */
export interface TreeRunConfig {
  /** The constructed behavior tree to run. */
  tree: BehaviorTree;

  /** Session key for the ActorServer. */
  sessionId: string;

  /** Optional auto-tick — omit for on-demand ticking only. */
  autoTick?: { intervalMs: number };
}
