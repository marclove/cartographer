import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage, SDKAssistantMessage, SDKResultMessage, SDKSystemMessage, SDKToolProgressMessage, SDKRateLimitEvent, OnElicitation as SDKOnElicitation } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, AgentConfig, AgentMessage, AgentElicitationRequest, AgentSendOptions, AgentInfo, ThinkingCapable, StreamCapable } from './agent.js';
import { createBlackboardMcpServer } from './blackboard-mcp.js';

/**
 * Configuration for a ClaudeSDKAgent.
 * Flat intersection of AgentConfig and SDK Options — all SDK options
 * sit at the top level alongside `name`.
 */
export type ClaudeSDKAgentConfig = AgentConfig & Partial<Options>;

type ActiveQuery = ReturnType<typeof query> | null

/**
 * Concrete Agent implementation wrapping the Claude Agent SDK V1 stable API.
 *
 * Each `send()` call creates a fresh `query()` call. Sessions are resumed
 * automatically via the SDK's `resume` option. The agent tracks a private
 * session ID for agents without named sessions.
 */
export class ClaudeSDKAgent implements Agent, ThinkingCapable, StreamCapable {
  readonly name: string;
  readonly supportsThinking = true as const;
  readonly supportsStreaming = true as const;
  private readonly config: ClaudeSDKAgentConfig;
  private _lastSessionId: string | null = null;
  private _privateSessionId: string | null = null;
  private _activeQuery: ActiveQuery = null;
  private _closed = false;

  /**
   * Creates a new ClaudeSDKAgent.
   *
   * All SDK options (model, effort, maxTurns, allowedTools, mcpServers, etc.)
   * are passed as top-level properties alongside `name` in the config object.
   *
   * @param config - Agent name and optional SDK options. The MCP server name
   *   `"blackboard"` is reserved — a built-in blackboard server is injected
   *   automatically when AgentNode provides a blackboard via `send()`.
   *
   * @throws Error if `config.mcpServers` contains a key named `"blackboard"`.
   *
   * @example
   * ```typescript
   * const agent = new ClaudeSDKAgent({
   *   name: 'classifier',
   *   model: 'claude-haiku-4-5',
   *   effort: 'low',
   *   outputFormat: {
   *     type: 'json_schema',
   *     schema: { type: 'object', properties: { label: { type: 'string' } } },
   *   },
   * });
   * ```
   */
  constructor(config: ClaudeSDKAgentConfig) {
    this.name = config.name;

    if (config.mcpServers && 'blackboard' in config.mcpServers) {
      throw new Error(
        `ClaudeSDKAgent "${config.name}": the MCP server name "blackboard" is reserved. ` +
        'A built-in blackboard MCP server is automatically injected under this name. ' +
        'Rename your MCP server to avoid the conflict.',
      );
    }

    this.config = config;
  }

  /**
   * The session ID from the most recent `send()` call, or `null` if no
   * SDK call has completed yet. May reflect a named session, not just
   * the agent's private session — use `_privateSessionId` internally
   * when the private session is specifically needed.
   */
  get sessionId(): string | null {
    return this._lastSessionId;
  }

  /**
   * Send a prompt to Claude and return an async iterable of response messages.
   *
   * Each call creates a fresh SDK `query()`. If no explicit session options are
   * provided, the agent automatically resumes its private session so conversation
   * history accumulates across turns. When `options.session` is provided, the
   * caller controls which session to resume or fork.
   *
   * The returned iterable yields {@link AgentMessage} values in order: a
   * `session_start` message first, then `thinking`, `text`, `tool_use`,
   * `stream`, and `provider_event` messages as the SDK streams them, and
   * finally a `result` message indicating success or error.
   *
   * @param prompt - The user prompt to send to Claude.
   * @param options - Per-invocation options including blackboard access,
   *   abort signal, structured output schema, and session control.
   * @returns An async iterable of provider-agnostic {@link AgentMessage} values.
   *
   * @throws Error if the agent has been closed via {@link close}.
   *
   * @example
   * ```typescript
   * for await (const msg of agent.send('Classify this ticket')) {
   *   if (msg.type === 'result' && msg.subtype === 'success') {
   *     console.log(msg.output);
   *   }
   * }
   * ```
   */
  send(prompt: string, options?: AgentSendOptions): AsyncIterable<AgentMessage> {
    if (this._closed) {
      throw new Error(`Agent "${this.name}" is closed and cannot accept new prompts.`);
    }

    const agent = this;
    return {
      [Symbol.asyncIterator]() {
        return agent._createSendIterator(prompt, options);
      },
    };
  }

  /**
   * Return provider-agnostic metadata about this agent for dashboard introspection.
   *
   * Includes the agent's name and, when configured, the model, allowed tools,
   * and MCP server names. This information is used by the CLI formatter and
   * dashboard UIs to display agent details without coupling to SDK internals.
   *
   * @returns An {@link AgentInfo} object with the agent's identifying metadata.
   */
  getInfo(): AgentInfo {
    const info: AgentInfo = { name: this.name };
    if (this.config.model) info.model = this.config.model;
    if (this.config.allowedTools) info.tools = this.config.allowedTools;
    if (this.config.mcpServers) info.mcpServers = Object.keys(this.config.mcpServers);
    return info;
  }

  /**
   * Permanently close this agent, releasing SDK resources.
   *
   * Marks the agent as closed so subsequent `send()` calls throw immediately.
   * If an SDK query is currently in flight, it is closed via the SDK's `close()`
   * method, which terminates the underlying subprocess.
   *
   * This method is idempotent — calling it multiple times has no additional effect.
   */
  async close(): Promise<void> {
    this._closed = true;
    if (this._activeQuery) {
      (this._activeQuery as ActiveQuery)?.close?.();
      this._activeQuery = null;
    }
  }

  /**
   * Core async generator that drives a single SDK `query()` call.
   *
   * Handles session resolution (private vs. explicit), creates the SDK query
   * instance, and iterates over its messages. Each SDK message is mapped to
   * one or more {@link AgentMessage} values via {@link mapSdkMessage}.
   *
   * The `init` system message receives special handling: it captures the
   * session ID (updating both the public accessor and, when applicable, the
   * private session tracker) and yields a `session_start` message before the
   * mapped provider event.
   *
   * The `onMessage` callback from options is invoked for every yielded message.
   * Errors thrown by the callback are caught and emitted as `provider_event`
   * messages with subtype `onMessage_error` so they remain observable without
   * interrupting the stream.
   *
   * @param prompt - The user prompt forwarded to the SDK.
   * @param options - Per-invocation send options.
   */
  private async *_createSendIterator(
    prompt: string,
    options?: AgentSendOptions,
  ): AsyncGenerator<AgentMessage> {
    if (this._closed) throw new Error(`Agent "${this.name}" is closed and cannot accept new prompts.`);

    const sessionOpts = options?.session;
    // Distinguish "no session options" (use private session) from
    // "session options with no id" (create new named session)
    const resumeId = sessionOpts ? sessionOpts.id : this._privateSessionId;

    const queryOpts = this.buildQueryOptions(options);
    const queryInstance = query({
      prompt,
      options: {
        ...queryOpts,
        ...(resumeId ? { resume: resumeId } : {}),
        ...(resumeId && sessionOpts?.fork ? { forkSession: true } : {}),
      },
    } as any);

    this._activeQuery = queryInstance;

    try {
      for await (const msg of queryInstance) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          const sys = msg as SDKSystemMessage;
          const sessionId = sys.session_id;
          this._lastSessionId = sessionId;

          if (!sessionOpts) {
            this._privateSessionId = sessionId;
          }

          yield { type: 'session_start', sessionId };

          const mapped = this.mapSdkMessage(msg);
          yield* this._dispatchMapped(mapped, options?.onMessage);
          continue;
        }

        const mapped = this.mapSdkMessage(msg);
        yield* this._dispatchMapped(mapped, options?.onMessage);
      }
    } finally {
      this._activeQuery = null;
    }
  }

  private async *_dispatchMapped(
    mapped: AgentMessage[],
    onMessage?: (msg: AgentMessage) => void,
  ): AsyncGenerator<AgentMessage> {
    for (const m of mapped) {
      if (onMessage) {
        try {
          onMessage(m);
        } catch (err) {
          yield {
            type: 'provider_event',
            subtype: 'onMessage_error',
            data: err instanceof Error ? err.message : String(err),
          };
        }
      }
      yield m;
    }
  }

  /**
   * Build the SDK `Options` object from the agent config and per-call send options.
   *
   * Merges the agent's static configuration with per-invocation overrides:
   *
   * 1. **MCP servers** — copies user-configured servers and injects the built-in
   *    blackboard MCP server when a blackboard is provided, adding
   *    `mcp__blackboard__*` to allowed tools.
   *
   * 2. **Elicitation** — always installs a handler so the SDK never hangs waiting
   *    for interactive input. Delegates to the user's handler if provided;
   *    otherwise auto-declines and emits an `elicitation_declined` provider event.
   *
   * 3. **Output format** — converts `sendOptions.outputSchema` (JSON Schema) into
   *    the SDK's `outputFormat` shape, or strips the `$schema` property from an
   *    existing `outputFormat.schema` to satisfy SDK validation.
   *
   * 4. **Signal** — forwards the abort signal for cancellation support.
   *
   * @param sendOptions - Per-invocation options from the `send()` caller.
   * @returns A plain object suitable for spreading into the SDK `query()` call.
   */
  private buildQueryOptions(sendOptions?: AgentSendOptions): Record<string, unknown> {
    const { name: _name, ...sdkConfig } = this.config;
    const userOptions = sdkConfig as Partial<Options>;

    // Build MCP servers — blackboard is injected if available
    const mcpServers: Record<string, unknown> = { ...userOptions.mcpServers };
    const allowedTools = [...(userOptions.allowedTools ?? [])];

    if (sendOptions?.blackboard) {
      mcpServers.blackboard = createBlackboardMcpServer(
        sendOptions.blackboard,
        sendOptions.blackboardNamespace,
      );
      allowedTools.push('mcp__blackboard__*');
    }

    // Elicitation: always provide a handler so the SDK never hangs.
    // Maps the framework's OnElicitation to the SDK's OnElicitation.
    // Framework `cancel` maps to SDK `decline`.
    const userElicitation = sendOptions?.onElicitation;
    const onElicitation: SDKOnElicitation = async (request, opts) => {
      const elicitationRequest: AgentElicitationRequest = {
        message: request.message,
        ...(request.requestedSchema && { schema: request.requestedSchema as Record<string, unknown> }),
        ...(request.serverName && { serverName: request.serverName }),
        ...(request.mode && { mode: request.mode }),
        ...(request.url && { url: request.url }),
        ...(request.elicitationId && { elicitationId: request.elicitationId }),
      };
      if (userElicitation) {
        const response = await userElicitation(elicitationRequest, { signal: opts.signal });
        if (response.action === 'cancel') return { action: 'decline' as const };
        return response;
      }
      // No handler — silently decline. Framework-level notification
      // (agent:elicitation_declined event) is handled by wrapElicitation
      // in sdk-helpers.ts, not by the adapter.
      return { action: 'decline' as const };
    };

    // Handle outputSchema → outputFormat conversion, strip $schema in both paths
    let outputFormat = userOptions.outputFormat;
    if (sendOptions?.outputSchema) {
      const { $schema, ...schema } = sendOptions.outputSchema;
      outputFormat = { type: 'json_schema', schema } as any;
    } else if (outputFormat && 'schema' in outputFormat) {
      const { $schema, ...schema } = (outputFormat as any).schema as Record<string, unknown>;
      if ($schema) {
        outputFormat = { ...outputFormat, schema } as typeof outputFormat;
      }
    }

    const { onElicitation: _e, mcpServers: _m, allowedTools: _a, outputFormat: _o, ...restOptions } = userOptions;

    return {
      ...restOptions,
      mcpServers,
      allowedTools,
      permissionMode: restOptions.permissionMode ?? 'default',
      ...(outputFormat && { outputFormat }),
      onElicitation,
      ...(sendOptions?.signal && { signal: sendOptions.signal }),
    };
  }

  /**
   * Map a single SDK message to one or more provider-agnostic {@link AgentMessage} values.
   *
   * The SDK uses a discriminated union of message types. This method translates
   * each variant into the framework's own message types:
   *
   * - `assistant` → one message per content block (`thinking`, `text`, `tool_use`)
   * - `result` → a single `result` message with `success` or `error` subtype.
   *   For success results, structured output is preferred over raw text; raw text
   *   is JSON-parsed as a fallback.
   * - `stream_event` → a semantic `stream` message with the raw event
   * - `system` → a `provider_event` with subtype `init` or `status`
   * - `tool_progress` → a `provider_event` with normalized field names
   * - `rate_limit_event` → a `provider_event` wrapping rate limit info
   * - All other SDK types → a `provider_event` pass-through with the raw message
   *
   * @param msg - A single message from the SDK's async iterable.
   * @returns An array of zero or more mapped messages. The array may contain
   *   multiple entries for `assistant` messages with several content blocks.
   */
  private mapSdkMessage(msg: SDKMessage): AgentMessage[] {
    const messages: AgentMessage[] = [];

    switch (msg.type) {
      case 'assistant': {
        const assistant = msg as SDKAssistantMessage;
        for (const block of assistant.message.content) {
          if (block.type === 'thinking') {
            messages.push({ type: 'thinking', content: block.thinking });
          } else if (block.type === 'text') {
            messages.push({ type: 'text', content: block.text });
          } else if (block.type === 'tool_use') {
            messages.push({ type: 'tool_use', name: block.name, input: block.input });
          }
        }
        break;
      }

      case 'result': {
        const result = msg as SDKResultMessage;
        if (result.subtype === 'success') {
          let output: unknown = result.result;
          if (result.structured_output !== undefined) {
            output = result.structured_output;
          } else if (typeof result.result === 'string') {
            try { output = JSON.parse(result.result); } catch { output = result.result; }
          }
          messages.push({
            type: 'result',
            subtype: 'success',
            output,
            cost: result.total_cost_usd,
          });
        } else {
          messages.push({
            type: 'result',
            subtype: 'error',
            errors: result.errors,
            cost: result.total_cost_usd,
          });
        }
        break;
      }

      case 'system': {
        const sys = msg as SDKSystemMessage;
        messages.push({
          type: 'provider_event',
          subtype: sys.subtype === 'init' ? 'init' : 'status',
          data: sys,
        });
        break;
      }

      default: {
        // Provider-specific events — use the SDK's discriminated types
        if ('type' in msg) {
          const m = msg as Record<string, unknown>;
          if (m.type === 'stream_event') {
            messages.push({ type: 'stream', event: msg });
          } else if (m.type === 'tool_progress') {
            const tp = msg as SDKToolProgressMessage;
            messages.push({
              type: 'provider_event',
              subtype: 'tool_progress',
              data: { toolUseId: tp.tool_use_id, toolName: tp.tool_name, elapsedSeconds: tp.elapsed_time_seconds },
            });
          } else if (m.type === 'rate_limit_event') {
            const rl = msg as SDKRateLimitEvent;
            messages.push({ type: 'provider_event', subtype: 'rate_limit', data: { info: rl.rate_limit_info } });
          } else {
            // All other SDK message types pass through as provider events
            messages.push({ type: 'provider_event', subtype: String(m.type), data: msg });
          }
        }
        break;
      }
    }

    return messages;
  }
}
