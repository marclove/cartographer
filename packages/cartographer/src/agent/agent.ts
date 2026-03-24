import type { OnElicitation } from '@anthropic-ai/claude-agent-sdk';
import type { Blackboard } from '../types.js';

/**
 * Configuration for constructing an Agent.
 */
export interface AgentConfig {
  /** Human-readable name for identification and debugging. */
  name: string;
}

/**
 * Per-invocation options passed to `Agent.send()`.
 */
export interface AgentSendOptions {
  /** Blackboard for agent access. Provider decides how to expose it. */
  blackboard?: Blackboard;
  /** Namespace for scoped blackboard access. */
  blackboardNamespace?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Elicitation handler for interactive input requests. */
  onElicitation?: OnElicitation;
  /**
   * Called for each AgentMessage as it is produced. Invoked for each
   * message before it is yielded by the returned iterable.
   *
   * The Agent catches and swallows errors thrown by this callback —
   * a failing handler must not crash the agent loop or starve
   * queued turns. Errors are emitted as provider_event messages
   * with subtype 'onMessage_error' so they remain observable.
   */
  onMessage?: (msg: AgentMessage) => void;
  /**
   * JSON schema for structured output. When set, the provider uses
   * native schema validation if available. Providers without native
   * support include the schema in the prompt and parse the result
   * text as JSON internally.
   *
   * This is a JSON Schema object, not a Zod schema. Callers using
   * Zod should convert via z.toJSONSchema() before calling.
   */
  outputSchema?: Record<string, unknown>;
}

/**
 * Provider-agnostic metadata for dashboard introspection.
 */
export interface AgentInfo {
  name: string;
  model?: string;
  tools?: string[];
  /** Provider-specific metadata beyond the common fields. */
  [key: string]: unknown;
}

/**
 * Token usage information from a completed turn.
 */
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thoughtTokens?: number;
}

/**
 * Discriminated union of messages yielded by Agent.send().
 * Provider-agnostic — each concrete Agent maps its provider's
 * responses into these types.
 */
export type AgentMessage =
  | { type: 'thinking'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool_use'; name: string; input?: unknown }
  | { type: 'result'; subtype: 'success'; output: unknown; cost?: number; usage?: AgentUsage }
  | { type: 'result'; subtype: 'error'; errors?: unknown[]; cost?: number; usage?: AgentUsage }
  | { type: 'provider_event'; subtype: string; data: unknown };

/**
 * Abstract base class for all agent implementations.
 *
 * An Agent represents a configured AI agent that can process prompts
 * and stream responses. Concrete implementations wrap specific providers
 * (e.g., Claude SDK, ACP).
 *
 * The Agent's lifecycle is managed by its creator. Multiple BT nodes
 * and strategies may reference the same Agent instance. Each `send()`
 * call returns a scoped iterable for that turn's responses.
 */
export abstract class Agent {
  readonly name: string;

  constructor(config: AgentConfig) {
    this.name = config.name;
  }

  /** The active session ID, or null if no session has been created yet. */
  abstract get sessionId(): string | null;

  /**
   * Send a prompt and return an async iterable of response messages
   * scoped to this turn. Each call starts a new turn; conversation
   * history accumulates across turns within the same Agent instance.
   */
  abstract send(prompt: string, options?: AgentSendOptions): AsyncIterable<AgentMessage>;

  /** Return provider-agnostic metadata for dashboard introspection. */
  abstract getInfo(): AgentInfo;

  /** Clean up resources (e.g., SDK subprocess, ACP session). */
  abstract close(): Promise<void>;
}
