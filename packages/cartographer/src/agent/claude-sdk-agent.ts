import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, AgentMessage, AgentSendOptions, AgentInfo, ThinkingCapable, StreamCapable } from './agent.js';
import { mapSdkMessage } from './claude-sdk-mapper.js';
import { composeSdkOptions } from './claude-sdk-options.js';
import type { ClaudeSDKAgentConfig } from './claude-sdk-options.js';

export type { ClaudeSDKAgentConfig } from './claude-sdk-options.js';

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

    const queryOpts = composeSdkOptions(this.config, options);
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

          const mapped = mapSdkMessage(msg);
          yield* this._dispatchMapped(mapped, options?.onMessage);
          continue;
        }

        const mapped = mapSdkMessage(msg);
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

}
