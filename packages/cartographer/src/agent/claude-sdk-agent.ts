import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage, SDKAssistantMessage, SDKResultMessage, SDKSystemMessage, SDKToolProgressMessage, SDKRateLimitEvent } from '@anthropic-ai/claude-agent-sdk';
import { Agent } from './agent.js';
import type { AgentConfig, AgentMessage, AgentSendOptions, AgentInfo } from './agent.js';
import { createBlackboardMcpServer } from './blackboard-mcp.js';
import type { OnElicitation } from '@anthropic-ai/claude-agent-sdk';

/**
 * Configuration for a ClaudeSDKAgent.
 * Flat intersection of AgentConfig and SDK Options — all SDK options
 * sit at the top level alongside `name`.
 */
export type ClaudeSDKAgentConfig = AgentConfig & Partial<Options>;

/**
 * Concrete Agent implementation wrapping the Claude Agent SDK V1 stable API.
 *
 * Each `send()` call creates a fresh `query()` call. Sessions are resumed
 * automatically via the SDK's `resume` option. The agent tracks a private
 * session ID for agents without named sessions.
 */
export class ClaudeSDKAgent extends Agent {
  private readonly config: ClaudeSDKAgentConfig;
  private _sessionId: string | null = null;
  private _privateSessionId: string | null = null;
  private _activeQuery: ReturnType<typeof query> | null = null;
  private _closed = false;

  constructor(config: ClaudeSDKAgentConfig) {
    super(config);

    if (config.mcpServers && 'blackboard' in config.mcpServers) {
      throw new Error(
        `ClaudeSDKAgent "${config.name}": the MCP server name "blackboard" is reserved. ` +
        'A built-in blackboard MCP server is automatically injected under this name. ' +
        'Rename your MCP server to avoid the conflict.',
      );
    }

    this.config = config;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

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

  getInfo(): AgentInfo {
    const info: AgentInfo = { name: this.name };
    if (this.config.model) info.model = this.config.model;
    if (this.config.allowedTools) info.tools = this.config.allowedTools;
    if (this.config.mcpServers) info.mcpServers = Object.keys(this.config.mcpServers);
    return info;
  }

  async close(): Promise<void> {
    this._closed = true;
    if (this._activeQuery) {
      (this._activeQuery as any).close?.();
      this._activeQuery = null;
    }
  }

  // --- Private ---

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
          this._sessionId = sessionId;

          if (!sessionOpts) {
            this._privateSessionId = sessionId;
          }

          // Yield session_start for AgentNode registry integration
          yield { type: 'session_start', sessionId };

          // Also yield mapped provider_event so agent:init events still fire
          const mapped = this.mapSdkMessage(msg);
          for (const m of mapped) {
            if (options?.onMessage) {
              try {
                options.onMessage(m);
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
          continue;
        }

        const mapped = this.mapSdkMessage(msg);
        for (const m of mapped) {
          if (options?.onMessage) {
            try {
              options.onMessage(m);
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
    } finally {
      this._activeQuery = null;
    }
  }

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
    // Delegates to the user handler if one was provided; otherwise auto-
    // declines and emits a provider_event so the BT layer can fire
    // agent:elicitation_declined.
    const userElicitation = sendOptions?.onElicitation;
    const onMessageFn = sendOptions?.onMessage;
    const onElicitation: OnElicitation = async (request, opts) => {
      if (userElicitation) return userElicitation(request, opts);
      if (onMessageFn) {
        try {
          onMessageFn({
            type: 'provider_event',
            subtype: 'elicitation_declined',
            data: { request },
          });
        } catch { /* swallowed */ }
      }
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
          if (m.type === 'tool_progress') {
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
