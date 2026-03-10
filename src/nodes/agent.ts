import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { BaseNode } from './base.js';
import { NodeStatus } from '../types.js';
import type { AgentNodeConfig, TreeContext } from '../types.js';
import { createBlackboardMcpServer } from '../agent/blackboard-mcp.js';
import { emitMessageEvents } from '../agent/sdk-helpers.js';

/**
 * A leaf node that calls the Claude SDK when ticked.
 *
 * `AgentNode` brings AI reasoning into the behavior tree. It operates in
 * one of two modes — **structured** or **agentic** — selected via the
 * `mode` field of {@link AgentNodeConfig}.
 *
 * ---
 *
 * ## Structured mode
 *
 * Sends a single prompt and expects a response that conforms to a Zod
 * schema. Best for classification, extraction, scoring, or any task where
 * the output shape is known in advance.
 *
 * - Claude always has read/write access to the blackboard via a built-in
 *   MCP server. No additional tools are available in this mode.
 * - If `outputSchema` is provided, the response is validated and parsed;
 *   the default effort level is `'low'`.
 * - If `outputSchema` is omitted, the call is limited to one turn and the
 *   raw text response is stored on the blackboard; effort still defaults to
 *   `'low'`.
 * - On success, the output is stored at `{name}:output` on the blackboard.
 * - Use `mapResult` to derive a custom `NodeStatus` from the output.
 *   Without `mapResult`, any successful SDK response returns `SUCCESS`.
 *
 * ```ts
 * const classify = new AgentNode({
 *   name: 'classify-intent',
 *   mode: 'structured',
 *   prompt: (ctx) => `Classify this message: ${ctx.blackboard.get('userMessage')}`,
 *   outputSchema: z.object({
 *     intent: z.string(),
 *     confidence: z.number(),
 *   }),
 *   mapResult: (output, ctx) => {
 *     const { intent, confidence } = output as { intent: string; confidence: number };
 *     ctx.blackboard.set('intent', intent);
 *     return confidence >= 0.8 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
 *   },
 * });
 * ```
 *
 * ---
 *
 * ## Agentic mode
 *
 * Runs a multi-turn Claude session with access to tools. Best for open-ended
 * tasks that require planning, web browsing, code execution, or sequences
 * of tool calls that cannot be anticipated in advance.
 *
 * - Claude always has read/write access to the blackboard via the built-in
 *   MCP server, plus any additional MCP servers and tools specified in the
 *   config. The default effort level is `'high'`.
 * - Each tool call emits an `agent:tool_use` event so you can observe the
 *   agent's actions in real time.
 * - The final result text is stored at `{name}:output` on the blackboard.
 *
 * ```ts
 * const research = new AgentNode({
 *   name: 'research-agent',
 *   mode: 'agentic',
 *   systemPrompt: 'You are a concise research assistant.',
 *   prompt: (ctx) => `Research this topic: ${ctx.blackboard.get('topic')}`,
 *   allowedTools: ['web-search', 'read-url'],
 *   maxTurns: 10,
 *   maxBudgetUsd: 0.25,
 *   blackboardNamespace: 'research',
 * });
 * ```
 *
 * ---
 *
 * ## Blackboard namespace
 *
 * When `blackboardNamespace` is set, Claude's MCP tools operate on a
 * scoped view of the blackboard. Reads and writes are prefixed with the
 * namespace, keeping the agent's data isolated from other nodes. The full
 * prefixed keys (e.g. `research:output`) remain accessible from the root
 * blackboard.
 *
 * ## Result caching
 *
 * When `cache: true`, the status returned by the first successful execution
 * is stored internally and returned on all subsequent ticks without calling
 * the SDK. The cache is cleared when `reset()` is called.
 *
 * ```ts
 * const expensiveAgent = new AgentNode({
 *   name: 'plan',
 *   mode: 'structured',
 *   prompt: 'Generate an execution plan',
 *   outputSchema: z.object({ steps: z.array(z.string()) }),
 *   cache: true, // SDK called only once; re-ticking returns the cached status
 * });
 * ```
 *
 * ## Events emitted
 *
 * | Event | When |
 * |---|---|
 * | `agent:prompt` | After the prompt is resolved, before calling the SDK |
 * | `agent:thinking` | When Claude produces a thinking (chain-of-thought) block |
 * | `agent:text` | When Claude produces a text content block |
 * | `agent:tool_use` | For each tool call in both structured and agentic mode |
 * | `agent:response` | When the SDK returns a successful final result |
 * | `agent:error` | When the SDK returns an error result |
 * | `agent:stream` | For each raw streaming delta event |
 * | `agent:message` | For every raw SDK message (catch-all) |
 * | `agent:tool_progress` | When a tool reports execution progress |
 * | `agent:init` | When the SDK emits a session init message |
 * | `agent:status` | When the SDK emits a status change |
 * | `agent:rate_limit` | When the SDK reports a rate limit event |
 */
export class AgentNode extends BaseNode {
  private config: AgentNodeConfig;

  /**
   * Stores the cached `NodeStatus` when `config.cache` is `true`.
   * `null` means no cached result is available (either caching is disabled
   * or `reset()` has been called since the last execution).
   */
  private cachedStatus: NodeStatus | null = null;

  constructor(config: AgentNodeConfig) {
    super(config.name);
    this.config = config;
  }

  /**
   * Clear the cached status so the next tick calls the SDK again.
   *
   * Only has an effect when `cache: true` was set in the config. Has no
   * effect when caching is disabled.
   */
  reset(): void {
    this.cachedStatus = null;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // Return the cached result from a previous tick without calling the SDK.
    if (this.config.cache && this.cachedStatus !== null) {
      return this.cachedStatus;
    }

    // Resolve the prompt — it may be a static string or a function that
    // builds the prompt dynamically from the current context.
    const prompt = typeof this.config.prompt === 'function'
      ? this.config.prompt(context)
      : this.config.prompt;

    context.events.emit('agent:prompt', {
      node: this,
      prompt,
      mode: this.config.mode,
    });

    const status = this.config.mode === 'structured'
      ? await this.executeStructured(prompt, context)
      : await this.executeUnstructured(prompt, context);

    if (this.config.cache) {
      this.cachedStatus = status;
    }

    return status;
  }

  /**
   * Run a single-turn (or schema-constrained) Claude call.
   *
   * The blackboard is always available to Claude as an MCP tool server.
   * When `outputSchema` is provided, the response is parsed and validated
   * against that schema; otherwise the call is capped at one turn and the
   * raw response text is used as the output.
   *
   * On a successful SDK result:
   * 1. The output (parsed schema object, or raw text) is stored on the
   *    blackboard at `{node.name}:output`.
   * 2. If `mapResult` is configured, its return value is used as the status.
   * 3. Otherwise `SUCCESS` is returned.
   *
   * Returns `FAILURE` if the SDK reports a non-success subtype or if the
   * message stream ends without producing a result.
   */
  private async executeStructured(prompt: string, context: TreeContext): Promise<NodeStatus> {
    const blackboardServer = createBlackboardMcpServer(
      context.blackboard,
      this.config.blackboardNamespace,
    );

    const options: Record<string, unknown> = {
      mcpServers: { blackboard: blackboardServer },
      // Structured mode only exposes blackboard tools; no user-provided tools.
      allowedTools: ['mcp__blackboard__*'],
      model: this.config.model,
      // Default to 'low' effort for structured calls — they are typically
      // simple extraction or classification tasks.
      effort: this.config.effort ?? 'low',
    };

    if (this.config.outputSchema) {
      // Strip the $schema meta-property before passing to the SDK.
      const { $schema, ...schema } = z.toJSONSchema(this.config.outputSchema) as Record<string, unknown>;
      options.outputFormat = {
        type: 'json_schema',
        schema,
      };
    } else {
      // Without a schema, cap at one turn to avoid open-ended generation.
      options.maxTurns = 1;
    }

    for await (const message of query({ prompt, options } as any)) {
      const msg = message as any;

      this.emitNodeMessageEvents(msg, context);

      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          // Prefer the SDK's pre-parsed structured_output; fall back to
          // JSON-parsing the raw result string, then the string itself.
          let output = msg.structured_output;
          if (output === undefined && typeof msg.result === 'string') {
            try {
              output = JSON.parse(msg.result);
            } catch {
              output = msg.result;
            }
          }

          context.events.emit('agent:response', {
            node: this,
            result: output,
            cost: msg.total_cost_usd,
          });

          if (output !== undefined) {
            context.blackboard.set(`${this.name}:output`, output);
          }

          if (this.config.mapResult) {
            return this.config.mapResult(output, context);
          }

          return NodeStatus.SUCCESS;
        }

        context.events.emit('agent:error', {
          node: this,
          subtype: msg.subtype,
          errors: msg.errors,
          permissionDenials: msg.permission_denials,
          cost: msg.total_cost_usd,
        });
        return NodeStatus.FAILURE;
      }
    }

    return NodeStatus.FAILURE;
  }

  /**
   * Run a multi-turn Claude session with tool access.
   *
   * The blackboard MCP server is always included alongside any additional
   * MCP servers from `config.mcpServers`. Similarly, `mcp__blackboard__*`
   * is always appended to the caller's `allowedTools` list.
   *
   * While the session is running, each tool call Claude makes emits an
   * `agent:tool_use` event carrying the tool name and input.
   *
   * On the final SDK result message:
   * 1. The result text is stored on the blackboard at `{node.name}:output`.
   * 2. An `agent:response` event is emitted.
   * 3. Returns `SUCCESS` if the SDK subtype is `'success'`, else `FAILURE`.
   *
   * Returns `FAILURE` if the message stream ends without producing a result.
   */
  private async executeUnstructured(prompt: string, context: TreeContext): Promise<NodeStatus> {
    const blackboardServer = createBlackboardMcpServer(
      context.blackboard,
      this.config.blackboardNamespace,
    );

    const mcpServers: Record<string, unknown> = {
      blackboard: blackboardServer,
      ...this.config.mcpServers,
    };

    const allowedTools = [
      ...(this.config.allowedTools ?? []),
      'mcp__blackboard__*',
    ];

    const options: Record<string, unknown> = {
      mcpServers,
      allowedTools,
      permissionMode: this.config.permissionMode ?? 'default',
      model: this.config.model,
      // Default to 'high' effort for agentic calls — they are typically
      // complex, open-ended tasks that benefit from deeper reasoning.
      effort: this.config.effort ?? 'high',
      maxTurns: this.config.maxTurns,
      maxBudgetUsd: this.config.maxBudgetUsd,
      systemPrompt: this.config.systemPrompt,
    };

    for await (const message of query({ prompt, options } as any)) {
      const msg = message as any;

      this.emitNodeMessageEvents(msg, context);

      if (msg.type === 'result') {
        const result = msg.result;
        const cost = msg.total_cost_usd;

        if (msg.subtype === 'success') {
          context.events.emit('agent:response', {
            node: this,
            result,
            cost,
          });

          if (result !== undefined) {
            context.blackboard.set(`${this.name}:output`, result);
          }

          return NodeStatus.SUCCESS;
        }

        context.events.emit('agent:error', {
          node: this,
          subtype: msg.subtype,
          errors: msg.errors,
          permissionDenials: msg.permission_denials,
          cost,
        });
        return NodeStatus.FAILURE;
      }
    }

    return NodeStatus.FAILURE;
  }

  /**
   * Emit granular observability events for a raw SDK message.
   *
   * Delegates to the shared {@link emitMessageEvents} utility, passing
   * `this` as the node reference.
   */
  private emitNodeMessageEvents(msg: any, context: TreeContext): void {
    emitMessageEvents(msg, this, context.events);
  }
}
