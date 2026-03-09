import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import type { BTreeNode, TreeContext, AgentStrategyConfig } from '../types.js';

/**
 * Call the Claude SDK with a structured JSON schema output requirement and
 * return the parsed result, or `null` if the call fails for any reason.
 *
 * This is the low-level building block used by all three agent strategy
 * classes (`AgentSelectionStrategy`, `AgentExecutionStrategy`,
 * `AgentParallelStrategy`) to get Claude's decision in a machine-readable
 * form.
 *
 * **Return value semantics:**
 * - Returns `z.infer<T>` on success. The SDK's `structured_output` field is
 *   preferred; if absent, `msg.result` is JSON-parsed as a fallback.
 * - Returns `null` in any of these cases:
 *   - The SDK call throws an exception
 *   - The SDK result has a non-success subtype
 *   - The SDK result has no `structured_output` and `msg.result` cannot be
 *     JSON-parsed
 *   - The message stream ends without producing a `result` message
 *
 * This function never throws. All exceptions are caught and translated to
 * `null` so callers can implement graceful fallback behaviour.
 *
 * **Model and effort defaults:**
 * - `model` defaults to `'sonnet'` if not specified in `config`.
 * - `effort` defaults to `'low'` since strategy decisions are typically
 *   simple structured tasks.
 *
 * @param prompt - The prompt to send to Claude.
 * @param schema - The Zod schema that defines and types the expected output.
 *   Converted to JSON Schema internally (with the `$schema` meta-property
 *   stripped before passing to the SDK).
 * @param config - Strategy config providing `model` and `effort` overrides.
 * @returns The validated output typed as `z.infer<T>`, or `null` on failure.
 *
 * @example
 * ```ts
 * const Result = z.object({ label: z.string(), score: z.number() });
 *
 * const result = await queryStructured(
 *   'Classify this text as positive or negative with a confidence score',
 *   Result,
 *   { prompt: '', model: 'haiku', effort: 'low' },
 * );
 *
 * if (result) {
 *   console.log(result.label, result.score); // typed as { label: string; score: number }
 * }
 * ```
 */
export async function queryStructured<T extends z.ZodType>(
  prompt: string,
  schema: T,
  config: AgentStrategyConfig,
): Promise<z.infer<T> | null> {
  try {
    // Strip the $schema meta-property — the Claude SDK does not accept it.
    const { $schema, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
    for await (const message of query({
      prompt,
      options: {
        outputFormat: { type: 'json_schema', schema: jsonSchema },
        model: config.model ?? 'sonnet',
        effort: config.effort ?? 'low',
      },
    } as any)) {
      const msg = message as any;
      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          // Prefer the SDK's pre-parsed structured_output field.
          if (msg.structured_output) {
            return msg.structured_output as z.infer<T>;
          }
          // Fall back to JSON-parsing the raw result string.
          if (typeof msg.result === 'string') {
            try {
              return JSON.parse(msg.result) as z.infer<T>;
            } catch {
              // Unparseable — treat as failure.
              return null;
            }
          }
        }
        // Non-success result subtype.
        return null;
      }
    }
  } catch {
    // SDK threw an exception — treat as failure.
    return null;
  }

  // Stream ended without producing a result message.
  return null;
}

/**
 * Build the full prompt string that agent strategies send to Claude.
 *
 * Combines the caller's prompt (static string or dynamic function) with a
 * structured context block that tells Claude which children are available
 * and what the current blackboard contains. This composite prompt is what
 * Claude actually receives when strategies call {@link queryStructured}.
 *
 * The returned string has the following structure:
 * ```
 * {resolved basePrompt}
 *
 * Available children:
 * [{ "name": "childA", "description": "..." }, ...]
 *
 * Blackboard state:
 * { "key": value, ... }
 * ```
 *
 * **Child descriptions:** Each child entry includes a `description` field.
 * If `config.childDescriptions` contains an entry for the child's name, that
 * description is used; otherwise the child's name is used as the description.
 *
 * **Blackboard state:** All keys from `context.blackboard.keys()` are read
 * and serialised as a JSON object. For scoped blackboards, only keys visible
 * within that scope are included.
 *
 * @param config - The strategy config, providing the prompt and optional
 *   `childDescriptions`.
 * @param children - The child nodes whose names and descriptions are included.
 * @param context - The tree context, used to read the current blackboard state.
 * @returns The composite prompt string ready to send to Claude.
 *
 * @example
 * ```ts
 * const prompt = buildStrategyPrompt(
 *   {
 *     prompt: 'Choose the best data retrieval strategy',
 *     childDescriptions: {
 *       'from-cache': 'Fast but may be stale',
 *       'from-db':    'Always fresh, ~50ms latency',
 *     },
 *   },
 *   [cacheNode, dbNode],
 *   context,
 * );
 *
 * // prompt:
 * // "Choose the best data retrieval strategy
 * //
 * // Available children:
 * // [
 * //   { "name": "from-cache", "description": "Fast but may be stale" },
 * //   { "name": "from-db",    "description": "Always fresh, ~50ms latency" }
 * // ]
 * //
 * // Blackboard state:
 * // { "userId": "abc123", "latencyBudgetMs": 100 }"
 * ```
 */
export function buildStrategyPrompt(
  config: AgentStrategyConfig,
  children: BTreeNode[],
  context: TreeContext,
): string {
  // Resolve the prompt — may be a static string or a function that builds
  // it dynamically from the current children and context.
  const basePrompt = typeof config.prompt === 'function'
    ? config.prompt(children, context)
    : config.prompt;

  // Build the child info array. Falls back to the child's name as the
  // description when no explicit description has been provided.
  const childInfo = children.map((c) => ({
    name: c.name,
    description: config.childDescriptions?.[c.name] ?? c.name,
  }));

  // Snapshot the entire visible blackboard into a plain object.
  const blackboardState: Record<string, unknown> = {};
  for (const key of context.blackboard.keys()) {
    blackboardState[key] = context.blackboard.get(key);
  }

  return `${basePrompt}\n\nAvailable children:\n${JSON.stringify(childInfo, null, 2)}\n\nBlackboard state:\n${JSON.stringify(blackboardState, null, 2)}`;
}
