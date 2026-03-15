import { query } from '@anthropic-ai/claude-agent-sdk';
import { BaseNode } from './base.js';
import { NodeStatus } from '../types.js';
import type { AgentNodeConfig, TreeContext } from '../types.js';
import { createBlackboardMcpServer } from '../agent/blackboard-mcp.js';
import { emitMessageEvents, wrapElicitation } from '../agent/sdk-helpers.js';

/**
 * A leaf node that calls the Claude SDK when ticked.
 *
 * `AgentNode` brings AI reasoning into the behavior tree. Every call is
 * an agentic SDK invocation — Claude always has read/write access to the
 * blackboard via a built-in MCP server, and you can configure additional
 * tools, MCP servers, system prompts, turn limits, budget caps, and any
 * other SDK option via the `options` field.
 *
 * To request **structured output**, set `options.outputFormat` with a
 * JSON schema. The SDK validates the response and the parsed result is
 * stored on the blackboard at `{name}:output`. You can combine structured
 * output with tools, multi-turn interaction, and all other options.
 *
 * Without `outputFormat`, the raw text response is stored on the blackboard.
 *
 * ```ts
 * // Structured output with schema validation
 * const classify = new AgentNode({
 *   name: 'classify-intent',
 *   prompt: (ctx) => `Classify this message: ${ctx.blackboard.get('userMessage')}`,
 *   options: {
 *     model: 'claude-haiku-4-5-20251001',
 *     effort: 'low',
 *     outputFormat: {
 *       type: 'json_schema',
 *       schema: {
 *         type: 'object',
 *         properties: {
 *           intent: { type: 'string' },
 *           confidence: { type: 'number' },
 *         },
 *         required: ['intent', 'confidence'],
 *       },
 *     },
 *   },
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
 *   prompt: (ctx) => `Research this topic: ${ctx.blackboard.get('topic')}`,
 *   options: {
 *     systemPrompt: 'You are a concise research assistant.',
 *     allowedTools: ['web-search', 'read-url'],
 *     maxTurns: 10,
 *     maxBudgetUsd: 0.25,
 *   },
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
 * | `agent:elicitation_declined` | When an MCP server requests elicitation and no handler is configured |
 */
export class AgentNode extends BaseNode {
  private config: AgentNodeConfig;

  /**
   * Stores the cached `NodeStatus` when `config.cache` is `true`.
   * `null` means no cached result is available (either caching is disabled
   * or `reset()` has been called since the last execution).
   */
  private cachedStatus: NodeStatus | null = null;

  /**
   * The `AbortController` for the currently in-flight SDK `query()` call.
   * `null` when no call is in progress. Set at the start of `execute()`
   * and cleared when it completes (success or failure).
   */
  private activeAbortController: AbortController | null = null;

  /**
   * Tracks the in-flight SDK call so that `execute()` can return RUNNING
   * immediately on the first tick and poll for completion on subsequent ticks.
   * `null` when no work is in progress.
   */
  private _inflightState: {
    promise: Promise<NodeStatus>;
    result?: NodeStatus;
    error?: Error;
  } | null = null;

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
    this.activeAbortController = null;
    this._inflightState = null;
  }

  /**
   * Abort the in-flight SDK request, if any.
   *
   * Called by `BehaviorTree.abort()` when the tree is aborted. Signals the
   * `AbortController` passed to the SDK's `query()`, which cancels the
   * underlying API request.
   */
  abort(): void {
    this.activeAbortController?.abort();
    this._inflightState = null;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    // Return the cached result from a previous tick without calling the SDK.
    if (this.config.cache && this.cachedStatus !== null) {
      return this.cachedStatus;
    }

    // Poll path: check for completed inflight work
    if (this._inflightState) {
      if (this._inflightState.error) {
        const error = this._inflightState.error;
        this._inflightState = null;
        throw error;
      }
      if (this._inflightState.result !== undefined) {
        const result = this._inflightState.result;
        this._inflightState = null;
        return result;
      }
      // Still in progress
      return NodeStatus.RUNNING;
    }

    // Start path: kick off the SDK call in the background
    const state: { promise: Promise<NodeStatus>; result?: NodeStatus; error?: Error } = {
      promise: this._executeSDKCall(context),
    };
    state.promise.then(
      (status) => { state.result = status; },
      (error) => { state.error = error instanceof Error ? error : new Error(String(error)); },
    );
    this._inflightState = state;
    return NodeStatus.RUNNING;
  }

  /**
   * The actual SDK call logic, extracted from execute() so it can run
   * in the background while execute() returns RUNNING immediately.
   */
  private async _executeSDKCall(context: TreeContext): Promise<NodeStatus> {
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

    const userOptions = this.config.options ?? {};

    const mcpServers: Record<string, unknown> = {
      blackboard: blackboardServer,
      ...userOptions.mcpServers,
    };

    const allowedTools = [
      ...(userOptions.allowedTools ?? []),
      'mcp__blackboard__*',
    ];

    // Strip the $schema meta-property from outputFormat.schema if present —
    // the Claude SDK does not accept it, and Zod's toJSONSchema() adds it.
    let { outputFormat } = userOptions;
    if (outputFormat && 'schema' in outputFormat) {
      const { $schema, ...schema } = outputFormat.schema as Record<string, unknown>;
      if ($schema) {
        outputFormat = { ...outputFormat, schema } as typeof outputFormat;
      }
    }

    // Create a fresh AbortController for this execution so abort() can
    // cancel the in-flight SDK request. Bridge the tree's abort signal so
    // that BehaviorTree.abort() also cancels this SDK call.
    const abortController = new AbortController();
    if (context.signal) {
      if (context.signal.aborted) {
        abortController.abort();
      } else {
        context.signal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }
    this.activeAbortController = abortController;

    // Resolve elicitation handler: node-level > context-level > decline with event
    const userElicitationHandler = userOptions.onElicitation ?? context.onElicitation;
    const wrappedOnElicitation = wrapElicitation(userElicitationHandler, this, context.events);

    const { onElicitation: _nodeElicitation, ...restUserOptions } = userOptions;

    const options: Record<string, unknown> = {
      ...restUserOptions,
      mcpServers,
      allowedTools,
      permissionMode: restUserOptions.permissionMode ?? 'default',
      ...(outputFormat && { outputFormat }),
      abortController,
      onElicitation: wrappedOnElicitation,
    };

    try {
      for await (const message of query({ prompt, options } as any)) {
        const msg = message as any;

        emitMessageEvents(msg, this, context.events);

        if (msg.type === 'result') {
          const cost = msg.total_cost_usd;

          if (msg.subtype === 'success') {
            // When outputFormat was provided, prefer the SDK's pre-parsed
            // structured_output; fall back to JSON-parsing the raw result
            // string, then the string itself.
            let output: unknown;
            if (userOptions.outputFormat) {
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
              modelUsage: msg.modelUsage,
            });

            if (output !== undefined) {
              const ns = this.config.blackboardNamespace;
              const key = ns ? `${ns}:${this.name}:output` : `${this.name}:output`;
              context.blackboard.set(key, output);
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
            modelUsage: msg.modelUsage,
          });
          return NodeStatus.FAILURE;
        }
      }

      return NodeStatus.FAILURE;
    } finally {
      this.activeAbortController = null;
    }
  }
}
