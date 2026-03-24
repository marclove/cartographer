import type { Blackboard } from '../types.js';

// ──── Framework-owned elicitation types ────

/** Request for interactive input from the user during agent execution. */
export interface AgentElicitationRequest {
  /** Human-readable message explaining what input is needed. */
  message: string;
  /** JSON Schema describing the expected input shape (form mode). */
  schema?: Record<string, unknown>;
  /** Name of the MCP server that triggered the elicitation. */
  serverName?: string;
  /** Elicitation mode: 'form' for structured input, 'url' for browser-based auth. */
  mode?: string;
  /** URL to open (only for 'url' mode). */
  url?: string;
  /** Correlation ID for URL-mode elicitations. */
  elicitationId?: string;
}

/**
 * User response to an elicitation request.
 *
 * Three-action model (aligned with ACP's elicitation RFD):
 * - `accept` — user submitted data
 * - `decline` — user explicitly rejected
 * - `cancel` — user dismissed without decision
 */
export type AgentElicitationResponse =
  | { action: 'accept'; data?: unknown }
  | { action: 'decline' }
  | { action: 'cancel' };

/** Options passed to elicitation handlers alongside the request. */
export interface ElicitationOptions {
  /** Abort signal from the tree context — handlers should observe this for cancellation. */
  signal?: AbortSignal;
}

/**
 * Handler for elicitation requests during agent execution.
 *
 * Provider-agnostic — each concrete adapter maps between this
 * framework type and its provider's elicitation API.
 */
export type OnElicitation = (
  request: AgentElicitationRequest,
  options?: ElicitationOptions,
) => Promise<AgentElicitationResponse>;

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
  /**
   * Session options controlling which conversation to resume, fork, or create.
   * When omitted, the agent manages its own private session.
   */
  session?: AgentSessionOptions;
}

/**
 * Session options for Agent.send().
 *
 * Controls whether the agent creates a new session, resumes an existing
 * session, or forks from one. These options are provider-agnostic —
 * each concrete Agent maps them to its provider's session API.
 */
export interface AgentSessionOptions {
  /** Provider session ID to resume. When undefined, a new session is created. */
  id?: string;
  /** Fork from the session instead of appending to it. Requires `id` to be set. */
  fork?: boolean;
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

// ──── Core message types (every adapter produces these) ────

/** Model text output. */
export interface AgentTextMessage { type: 'text'; content: string }
/** Model tool invocation. */
export interface AgentToolUseMessage { type: 'tool_use'; name: string; input?: unknown }
/** Successful turn completion. */
export interface AgentSuccessResult { type: 'result'; subtype: 'success'; output: unknown; cost?: number; usage?: AgentUsage }
/** Failed turn completion. */
export interface AgentErrorResult { type: 'result'; subtype: 'error'; errors?: unknown[]; cost?: number; usage?: AgentUsage }
/** Terminal result — success or error. */
export type AgentResultMessage = AgentSuccessResult | AgentErrorResult;
/** Session established or resumed. Yielded first. */
export interface AgentSessionStartMessage { type: 'session_start'; sessionId: string }
/** Escape hatch for provider-specific events that don't map to semantic types. */
export interface AgentProviderEvent { type: 'provider_event'; subtype: string; data: unknown }

// ──── Capability-specific message types ────

/** Extended thinking / reasoning traces. Requires {@link ThinkingCapable}. */
export interface AgentThinkingMessage { type: 'thinking'; content: string }
/** Raw streaming events from the provider. Requires {@link StreamCapable}. */
export interface AgentStreamMessage { type: 'stream'; event: unknown }

// ──── Full message union ────

/**
 * Discriminated union of messages yielded by Agent.send().
 *
 * Provider-agnostic — each concrete adapter maps its provider's
 * responses into these types. Core types are produced by every
 * adapter; capability-specific types are produced only by adapters
 * that implement the corresponding capability interface.
 *
 * Lifecycle contract: adapters yield `session_start` first
 * and `result` last.
 */
export type AgentMessage =
  | AgentTextMessage
  | AgentToolUseMessage
  | AgentResultMessage
  | AgentSessionStartMessage
  | AgentThinkingMessage
  | AgentStreamMessage
  | AgentProviderEvent;

// ──── Capability interfaces ────

/** Adapter may yield {@link AgentThinkingMessage} (extended reasoning traces). */
export interface ThinkingCapable {
  readonly supportsThinking: true;
}

/** Adapter may yield {@link AgentStreamMessage} (raw provider streaming events). */
export interface StreamCapable {
  readonly supportsStreaming: true;
}

/** Runtime check for {@link ThinkingCapable}. */
export function isThinkingCapable(agent: Agent): agent is Agent & ThinkingCapable {
  return 'supportsThinking' in agent && (agent as Record<string, unknown>).supportsThinking === true;
}

/** Runtime check for {@link StreamCapable}. */
export function isStreamCapable(agent: Agent): agent is Agent & StreamCapable {
  return 'supportsStreaming' in agent && (agent as Record<string, unknown>).supportsStreaming === true;
}

/**
 * Port interface for all agent implementations.
 *
 * An Agent represents a configured AI agent that can process prompts
 * and stream responses. Concrete implementations wrap specific providers
 * (e.g., Claude SDK, ACP) and implement this interface.
 *
 * The Agent's lifecycle is managed by its creator. Multiple BT nodes
 * and strategies may reference the same Agent instance. Each `send()`
 * call returns a scoped iterable for that turn's responses.
 */
export interface Agent {
  /** Human-readable name for identification and debugging. */
  readonly name: string;

  /** The active session ID, or null if no session has been created yet. */
  readonly sessionId: string | null;

  /**
   * Send a prompt and return an async iterable of response messages
   * scoped to this turn. Each call starts a new turn; conversation
   * history accumulates across turns within the same Agent instance.
   */
  send(prompt: string, options?: AgentSendOptions): AsyncIterable<AgentMessage>;

  /** Return provider-agnostic metadata for dashboard introspection. */
  getInfo(): AgentInfo;

  /** Clean up resources (e.g., SDK subprocess, ACP session). */
  close(): Promise<void>;
}
