import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import type { BTreeNode, TreeContext, TreeEvents, TypedEventEmitter, AgentStrategyConfig } from '../types.js';

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
 * - `model` defaults to `'sonnet'` if not specified in `config.options`.
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
 *   { prompt: '', options: { model: 'claude-haiku-4-5-20251001', effort: 'low' } },
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
  onMessage?: (msg: unknown) => void,
  abortController?: AbortController,
): Promise<z.infer<T> | null> {
  try {
    // Strip the $schema meta-property — the Claude SDK does not accept it.
    const { $schema, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
    const userOptions = config.options ?? {};
    for await (const message of query({
      prompt,
      options: {
        ...userOptions,
        outputFormat: { type: 'json_schema', schema: jsonSchema },
        model: userOptions.model ?? 'sonnet',
        effort: userOptions.effort ?? 'low',
        ...(abortController && { abortController }),
      },
    } as any)) {
      const msg = message as any;
      onMessage?.(msg);
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
 * Emit granular observability events for a raw SDK message.
 *
 * Handles assistant content blocks (thinking, text, tool_use), streaming
 * deltas, system messages, tool progress, rate limits, and the catch-all
 * `agent:message`. Does NOT emit lifecycle events (`agent:response`,
 * `agent:error`) — those are handled separately by the caller.
 */
export function emitMessageEvents(
  msg: any,
  node: BTreeNode,
  events: TypedEventEmitter<TreeEvents>,
): void {
  // Catch-all: emit every raw SDK message for power users.
  events.emit('agent:message', { node, message: msg });

  // Assistant messages carry content blocks: thinking, text, tool_use.
  if (msg.type === 'assistant' && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === 'thinking') {
        events.emit('agent:thinking', { node, thinking: block.thinking });
      } else if (block.type === 'text') {
        events.emit('agent:text', { node, text: block.text });
      } else if (block.type === 'tool_use') {
        events.emit('agent:tool_use', { node, tool: block.name, input: block.input });
      }
    }
  }

  // Raw streaming deltas.
  if (msg.type === 'stream_event') {
    events.emit('agent:stream', { node, event: msg.event });
  }

  // Tool execution progress.
  if (msg.type === 'tool_progress') {
    events.emit('agent:tool_progress', {
      node,
      toolUseId: msg.tool_use_id,
      toolName: msg.tool_name,
      elapsedSeconds: msg.elapsed_time_seconds,
    });
  }

  // System messages: init, status changes.
  if (msg.type === 'system') {
    if (msg.subtype === 'init') {
      events.emit('agent:init', {
        node,
        sessionId: msg.session_id,
        model: msg.model,
        tools: msg.tools,
        mcpServers: msg.mcp_servers,
      });
    } else if (msg.subtype === 'status') {
      events.emit('agent:status', { node, status: msg.status });
    }
  }

  // Rate limit warnings.
  if (msg.type === 'rate_limit_event') {
    events.emit('agent:rate_limit', { node, info: msg.rate_limit_info });
  }
}

/**
 * Create a message handler for strategy SDK calls that emits both
 * per-message observability events and lifecycle events (`agent:response`,
 * `agent:error`) on result messages.
 *
 * Intended for use as the `onMessage` callback to {@link queryStructured}.
 */
export function createStrategyMessageHandler(
  node: BTreeNode,
  events: TypedEventEmitter<TreeEvents>,
): (msg: unknown) => void {
  return (msg: unknown) => {
    const m = msg as any;
    emitMessageEvents(m, node, events);

    if (m.type === 'result') {
      if (m.subtype === 'success') {
        // Prefer structured_output; fall back to JSON-parsing result.
        let output = m.structured_output;
        if (output === undefined && typeof m.result === 'string') {
          try {
            output = JSON.parse(m.result);
          } catch {
            output = m.result;
          }
        }
        events.emit('agent:response', {
          node,
          result: output,
          cost: m.total_cost_usd,
        });
      } else {
        events.emit('agent:error', {
          node,
          subtype: m.subtype,
          errors: m.errors,
          permissionDenials: m.permission_denials,
          cost: m.total_cost_usd,
        });
      }
    }
  };
}

/**
 * Build the full prompt string that agent strategies send to Claude.
 *
 * Combines the caller's base prompt with two contextual sections — the
 * list of available child nodes and a snapshot of the current blackboard
 * state — so Claude has everything it needs to make an informed decision.
 * This composite prompt is what Claude actually receives when strategies
 * call {@link queryStructured}.
 *
 * **Prompt resolution:** The `config.prompt` value can be either a static
 * string or a function `(children, context) => string` for dynamic prompt
 * construction. In both cases, the child and blackboard sections are
 * appended automatically — you do not need to include them yourself.
 *
 * The returned string has the following structure:
 *
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
 * If `config.childDescriptions` contains an entry for the child's name,
 * that description is used; otherwise the child's name is used as the
 * description. Providing meaningful descriptions helps Claude distinguish
 * between children that have similar names.
 *
 * **Blackboard state:** All keys from `context.blackboard.keys()` are
 * read and serialised as a JSON object. For scoped blackboards (created
 * via `ScopedBlackboard`), only keys visible within that scope are
 * included — parent or sibling scopes are not leaked.
 *
 * @param config - The strategy config, providing the base prompt and
 *   optional `childDescriptions` map.
 * @param children - The child nodes whose names and descriptions are
 *   included in the prompt's "Available children" section.
 * @param context - The tree context, used to read the current blackboard
 *   state and (when `prompt` is a function) passed to the prompt builder.
 * @returns The composite prompt string ready to send to Claude.
 *
 * @example
 * **Static prompt with child descriptions:**
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
 * // Returns:
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
 *
 * @example
 * **Dynamic prompt built from context:**
 * ```ts
 * const prompt = buildStrategyPrompt(
 *   {
 *     prompt: (children, ctx) => {
 *       const intent = ctx.blackboard.get<string>('intent');
 *       return `For a "${intent}" request, choose which of these ${children.length} strategies to try first`;
 *     },
 *   },
 *   [quickReply, deepResearch, fallback],
 *   context,
 * );
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
