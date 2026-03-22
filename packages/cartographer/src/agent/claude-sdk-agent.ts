import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { Agent } from './agent.js';
import type { AgentConfig, AgentMessage, AgentSendOptions, AgentInfo, AgentUsage } from './agent.js';
import { AsyncQueue } from './async-queue.js';
import { createBlackboardMcpServer } from './blackboard-mcp.js';
import { wrapElicitation } from './sdk-helpers.js';

/**
 * Configuration for a ClaudeSDKAgent.
 * Flat intersection of AgentConfig and SDK Options — all SDK options
 * sit at the top level alongside `name`.
 */
export type ClaudeSDKAgentConfig = AgentConfig & Partial<Options>;

/**
 * Concrete Agent implementation wrapping the Claude Agent SDK V1 stable API.
 *
 * Uses the V1 `AsyncIterable<SDKUserMessage>` prompt pattern for multi-turn
 * conversations. A single long-lived `query()` call is created lazily on
 * first `send()`. The `AsyncQueue` bridges `send()` calls to the SDK input.
 */
export class ClaudeSDKAgent extends Agent {
  private readonly config: ClaudeSDKAgentConfig;
  private queryInstance: ReturnType<typeof query> | null = null;
  private messageQueue = new AsyncQueue<{ type: string; session_id: string; message: unknown; parent_tool_use_id: null }>();
  private _sessionId: string | null = null;
  private _closed = false;

  /** The currently active turn's resolver — used by the demux loop. */
  private activeTurnResolve: ((msg: AgentMessage) => void) | null = null;
  private activeTurnReject: ((err: Error) => void) | null = null;
  private activeTurnDone: (() => void) | null = null;

  /** Pending turns waiting for the demux to route messages to them. */
  private pendingTurns: Array<{
    resolve: (msg: AgentMessage) => void;
    reject: (err: Error) => void;
    done: () => void;
    signal?: AbortSignal;
    onMessage?: (msg: AgentMessage) => void;
    outputSchema?: Record<string, unknown>;
  }> = [];

  private demuxRunning = false;

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

    const self = this;
    const messageBuffer: AgentMessage[] = [];
    let turnResolve: ((value: IteratorResult<AgentMessage>) => void) | null = null;
    let turnReject: ((err: Error) => void) | null = null;
    let turnCompleted = false;

    // Register this turn's callbacks for the demux loop
    const turnEntry = {
      resolve(msg: AgentMessage) {
        if (turnResolve) {
          const r = turnResolve;
          turnResolve = null;
          turnReject = null;
          r({ value: msg, done: false });
        } else {
          messageBuffer.push(msg);
        }
      },
      reject(err: Error) {
        if (turnReject) {
          const r = turnReject;
          turnResolve = null;
          turnReject = null;
          r(err);
        }
        turnCompleted = true;
      },
      done() {
        turnCompleted = true;
        if (turnResolve) {
          const r = turnResolve;
          turnResolve = null;
          turnReject = null;
          r({ value: undefined as unknown as AgentMessage, done: true });
        }
      },
      signal: options?.signal,
      onMessage: options?.onMessage,
      outputSchema: options?.outputSchema,
    };

    // Check if signal is already aborted
    if (options?.signal?.aborted) {
      return (async function* () { /* empty — turn dropped preemptively */ })();
    }

    // Handle preemptive cancellation: if signal fires before the turn starts
    if (options?.signal) {
      const onAbort = () => {
        const idx = self.pendingTurns.indexOf(turnEntry);
        if (idx !== -1) {
          // Still queued — drop it preemptively
          self.pendingTurns.splice(idx, 1);
          turnEntry.done();
        }
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    this.pendingTurns.push(turnEntry);

    // Push the SDK user message onto the queue
    this.messageQueue.push({
      type: 'user',
      session_id: '',
      message: { role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] },
      parent_tool_use_id: null,
    });

    // Ensure the demux loop is running
    this.ensureDemuxLoop(options);

    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AgentMessage>> {
            if (messageBuffer.length > 0) {
              return { value: messageBuffer.shift()!, done: false };
            }
            if (turnCompleted) {
              return { value: undefined as unknown as AgentMessage, done: true };
            }
            return new Promise<IteratorResult<AgentMessage>>((resolve, reject) => {
              turnResolve = resolve;
              turnReject = reject;
            });
          },
          async return(): Promise<IteratorResult<AgentMessage>> {
            turnCompleted = true;
            return { value: undefined as unknown as AgentMessage, done: true };
          },
          async throw(err: Error): Promise<IteratorResult<AgentMessage>> {
            turnCompleted = true;
            throw err;
          },
        };
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
    this.messageQueue.close(new Error('Agent closed'));
    // Signal all pending turns
    for (const turn of this.pendingTurns) {
      turn.reject(new Error('Agent closed'));
    }
    this.pendingTurns.length = 0;
    if (this.activeTurnReject) {
      this.activeTurnReject(new Error('Agent closed'));
      this.activeTurnResolve = null;
      this.activeTurnReject = null;
      this.activeTurnDone = null;
    }
    if (this.queryInstance) {
      (this.queryInstance as any).close?.();
      this.queryInstance = null;
    }
  }

  // --- Private ---

  private ensureDemuxLoop(sendOptions?: AgentSendOptions): void {
    if (this.demuxRunning) return;

    // Lazily create the SDK query on first send
    if (!this.queryInstance) {
      this.queryInstance = this.createQuery(sendOptions);
    }

    this.demuxRunning = true;
    this.runDemuxLoop().catch(() => {
      // Handled inside the loop
    });
  }

  private createQuery(sendOptions?: AgentSendOptions): ReturnType<typeof query> {
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

    // Resolve elicitation
    const wrappedElicitation = sendOptions?.onElicitation
      ? wrapElicitation(sendOptions.onElicitation, { id: this.name, name: this.name } as any, { emit: () => {} } as any)
      : undefined;

    // Handle outputSchema → outputFormat conversion
    let outputFormat = userOptions.outputFormat;
    if (sendOptions?.outputSchema) {
      const { $schema, ...schema } = sendOptions.outputSchema;
      outputFormat = { type: 'json_schema', schema } as any;
    }

    const { onElicitation: _e, mcpServers: _m, allowedTools: _a, outputFormat: _o, ...restOptions } = userOptions;

    const options: Record<string, unknown> = {
      ...restOptions,
      mcpServers,
      allowedTools,
      permissionMode: restOptions.permissionMode ?? 'default',
      ...(outputFormat && { outputFormat }),
      ...(wrappedElicitation && { onElicitation: wrappedElicitation }),
    };

    return query({ prompt: this.messageQueue as any, options } as any);
  }

  private async runDemuxLoop(): Promise<void> {
    try {
      for await (const rawMsg of this.queryInstance!) {
        const msg = rawMsg as any;

        // Extract sessionId from init messages
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          this._sessionId = msg.session_id;
        }

        // Activate the next pending turn if none is active
        if (!this.activeTurnResolve && this.pendingTurns.length > 0) {
          const turn = this.pendingTurns.shift()!;
          this.activeTurnResolve = turn.resolve;
          this.activeTurnReject = turn.reject;
          this.activeTurnDone = turn.done;
          this._activeTurnOnMessage = turn.onMessage;
        }

        // Map SDK message to AgentMessage(s) and route to active turn
        const agentMessages = this.mapSdkMessage(msg);

        for (const agentMsg of agentMessages) {
          // Invoke onMessage with error isolation
          const onMessage = this._activeTurnOnMessage;
          if (onMessage) {
            try {
              onMessage(agentMsg);
            } catch (err) {
              // Emit error as provider_event instead of crashing
              const errorMsg: AgentMessage = {
                type: 'provider_event',
                subtype: 'onMessage_error',
                data: err instanceof Error ? err.message : String(err),
              };
              this.activeTurnResolve?.(errorMsg);
            }
          }

          // Route to active turn
          this.activeTurnResolve?.(agentMsg);

          // If this is a result message, the turn is complete
          if (agentMsg.type === 'result') {
            this.activeTurnDone?.();
            this.activeTurnResolve = null;
            this.activeTurnReject = null;
            this.activeTurnDone = null;
            this._activeTurnOnMessage = undefined;
          }
        }
      }
    } catch (err) {
      // SDK query terminated unexpectedly
      const error = err instanceof Error ? err : new Error(String(err));

      // Fail the active turn
      if (this.activeTurnReject) {
        this.activeTurnReject(error);
        this.activeTurnResolve = null;
        this.activeTurnReject = null;
        this.activeTurnDone = null;
      }

      // Fail all queued turns
      this.messageQueue.close(error);
      for (const turn of this.pendingTurns) {
        turn.reject(error);
      }
      this.pendingTurns.length = 0;
    } finally {
      this.demuxRunning = false;
    }
  }

  private _activeTurnOnMessage?: (msg: AgentMessage) => void;

  private mapSdkMessage(msg: any): AgentMessage[] {
    const messages: AgentMessage[] = [];

    // Assistant messages carry content blocks
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'thinking') {
          messages.push({ type: 'thinking', content: block.thinking });
        } else if (block.type === 'text') {
          messages.push({ type: 'text', content: block.text });
        } else if (block.type === 'tool_use') {
          messages.push({ type: 'tool_use', name: block.name, input: block.input });
        }
      }
    }

    // Result messages
    if (msg.type === 'result') {
      const usage: AgentUsage | undefined = msg.modelUsage ? {
        inputTokens: msg.modelUsage?.inputTokens,
        outputTokens: msg.modelUsage?.outputTokens,
        totalTokens: msg.modelUsage?.totalTokens,
        thoughtTokens: msg.modelUsage?.thoughtTokens,
      } : undefined;

      if (msg.subtype === 'success') {
        // Determine output based on whether structured output was requested
        let output: unknown = msg.result;
        if (msg.structured_output !== undefined) {
          output = msg.structured_output;
        } else if (typeof msg.result === 'string') {
          try {
            output = JSON.parse(msg.result);
          } catch {
            output = msg.result;
          }
        }

        messages.push({
          type: 'result',
          subtype: 'success',
          output,
          cost: msg.total_cost_usd,
          usage,
        });
      } else {
        messages.push({
          type: 'result',
          subtype: 'error',
          errors: msg.errors,
          cost: msg.total_cost_usd,
          usage,
        });
      }
    }

    // Provider-specific events
    if (msg.type === 'stream_event') {
      messages.push({ type: 'provider_event', subtype: 'stream', data: msg.event });
    }
    if (msg.type === 'tool_progress') {
      messages.push({
        type: 'provider_event',
        subtype: 'tool_progress',
        data: { toolUseId: msg.tool_use_id, toolName: msg.tool_name, elapsedSeconds: msg.elapsed_time_seconds },
      });
    }
    if (msg.type === 'system') {
      messages.push({
        type: 'provider_event',
        subtype: msg.subtype === 'init' ? 'init' : 'status',
        data: msg,
      });
    }
    if (msg.type === 'rate_limit_event') {
      messages.push({ type: 'provider_event', subtype: 'rate_limit', data: msg.rate_limit_info });
    }

    return messages;
  }
}
