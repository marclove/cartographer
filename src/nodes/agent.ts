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
 * `AgentNode` brings AI reasoning into the behavior tree. Every call is
 * an agentic SDK invocation — Claude always has read/write access to the
 * blackboard via a built-in MCP server, and you can attach additional
 * tools, MCP servers, system prompts, turn limits, and budget caps.
 *
 * To request **structured output**, provide an `outputSchema` in the
 * config. The SDK validates the response against the schema and the
 * parsed result is stored on the blackboard at `{name}:output`. You can
 * combine structured output with tools, multi-turn interaction, and all
 * other options.
 *
 * Without `outputSchema`, the raw text response is stored on the
 * blackboard.
 *
 * ```ts
 * // Structured output with schema validation
 * const classify = new AgentNode({
 *   name: 'classify-intent',
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
 * ```ts
 * // Multi-turn with tools
 * const research = new AgentNode({
 *   name: 'research-agent',
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
 * | `agent:tool_use` | For each tool call the agent makes |
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
    super(config.name, config.id);
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
    });

    // Build MCP servers — blackboard is always present, user servers merged in.
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
      effort: this.config.effort,
      maxTurns: this.config.maxTurns,
      maxBudgetUsd: this.config.maxBudgetUsd,
      systemPrompt: this.config.systemPrompt,
    };

    // When an output schema is provided, convert it to JSON Schema and
    // pass it to the SDK as the expected output format.
    if (this.config.outputSchema) {
      const { $schema, ...schema } = z.toJSONSchema(this.config.outputSchema) as Record<string, unknown>;
      options.outputFormat = {
        type: 'json_schema',
        schema,
      };
    }

    for await (const message of query({ prompt, options } as any)) {
      const msg = message as any;

      emitMessageEvents(msg, this, context.events);

      if (msg.type === 'result') {
        const cost = msg.total_cost_usd;

        if (msg.subtype === 'success') {
          // When outputSchema was provided, prefer the SDK's pre-parsed
          // structured_output; fall back to JSON-parsing the raw result
          // string, then the string itself.
          let output: unknown;
          if (this.config.outputSchema) {
            output = msg.structured_output;
            if (output === undefined && typeof msg.result === 'string') {
              try {
                output = JSON.parse(msg.result);
              } catch {
                output = msg.result;
              }
            }
          } else {
            output = msg.result;
          }

          context.events.emit('agent:response', {
            node: this,
            result: output,
            cost,
          });

          if (output !== undefined) {
            context.blackboard.set(`${this.name}:output`, output);
          }

          if (this.config.mapResult) {
            const status = this.config.mapResult(output, context);
            if (this.config.cache) {
              this.cachedStatus = status;
            }
            return status;
          }

          if (this.config.cache) {
            this.cachedStatus = NodeStatus.SUCCESS;
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
}
