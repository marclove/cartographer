import type { Agent, AgentMessage, AgentSendOptions, AgentInfo, AgentConfig } from './agent.js';

/**
 * A controllable Agent implementation for unit and integration tests.
 *
 * TestAgent mirrors the session and messaging behavior of real agents
 * (like {@link ClaudeSDKAgent}) without making network calls. Pre-load
 * the messages to yield via {@link setMessages}, then consume them
 * through {@link send}.
 *
 * Session handling follows the same contract as production agents:
 * - No session options → a stable private session is reused across `send()` calls
 * - `session.id` without `fork` → resumes the given session
 * - `session.id` with `fork`, or no `id` → generates a new session
 *
 * @example
 * ```typescript
 * const agent = new TestAgent({ name: 'mock' });
 * agent.setMessages([
 *   { type: 'text', content: 'Hello' },
 *   { type: 'result', subtype: 'success', output: 'done' },
 * ]);
 *
 * for await (const msg of agent.send('test prompt')) {
 *   console.log(msg.type); // 'session_start', 'text', 'result'
 * }
 * ```
 */
export class TestAgent implements Agent {
  readonly name: string;
  private messages: AgentMessage[] = [];
  private _sessionId: string | null = null;
  private _sessionCounter = 0;
  private _privateSessionId: string | null = null;
  private _info: AgentInfo;

  /**
   * Create a new TestAgent.
   *
   * @param config - Agent name and optional metadata overrides. Defaults to
   *   `{ name: 'test-agent' }` when omitted. The optional `info` property
   *   lets tests inject custom metadata (model, tools, etc.) that
   *   {@link getInfo} will return.
   */
  constructor(config: AgentConfig & { info?: Partial<AgentInfo> } = { name: 'test-agent' }) {
    this.name = config.name;
    this._info = { name: config.name, ...config.info };
  }

  /**
   * Pre-load the messages that {@link send} will yield.
   *
   * Each call replaces the previous message list. The messages are yielded
   * in order after the initial `session_start` message.
   *
   * @param msgs - The sequence of {@link AgentMessage} values to yield.
   */
  setMessages(msgs: AgentMessage[]): void {
    this.messages = msgs;
  }

  /**
   * The most recent session ID produced by {@link send}, or `null` if
   * `send()` has not been called yet. Reset to `null` by {@link close}.
   */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /**
   * Yield a `session_start` message followed by all pre-loaded messages.
   *
   * Session ID assignment follows the same rules as production agents:
   * - **No session options** — reuses a stable private session ID across
   *   multiple `send()` calls (created on first use).
   * - **Resume** (`session.id` set, `fork` falsy) — uses the provided ID directly.
   * - **New or fork** (no `id`, or `fork: true`) — generates a fresh
   *   `test-session-N` ID.
   *
   * The `onMessage` callback from options is invoked for each pre-loaded
   * message. Errors thrown by the callback are silently swallowed, matching
   * the behavior specified by the {@link Agent} contract.
   *
   * @param _prompt - Ignored. Accepted for interface compatibility.
   * @param options - Per-invocation options; `session` and `onMessage` are honored.
   */
  async *send(_prompt: string, options?: AgentSendOptions): AsyncIterable<AgentMessage> {
    const sessionOpts = options?.session;
    let sessionId: string;

    if (!sessionOpts) {
      // Private session — stable across sends
      if (!this._privateSessionId) {
        this._privateSessionId = `test-session-${++this._sessionCounter}`;
      }
      sessionId = this._privateSessionId;
    } else if (sessionOpts.id && !sessionOpts.fork) {
      // Resume: use provided ID
      sessionId = sessionOpts.id;
    } else {
      // New session or fork: generate new ID
      sessionId = `test-session-${++this._sessionCounter}`;
    }

    this._sessionId = sessionId;
    yield { type: 'session_start', sessionId };

    for (const msg of this.messages) {
      if (options?.onMessage) {
        try { options.onMessage(msg); } catch { /* swallowed per spec */ }
      }
      yield msg;
    }
  }

  /**
   * Return the metadata provided at construction.
   *
   * Returns the agent's name merged with any custom `info` fields passed
   * to the constructor.
   */
  getInfo(): AgentInfo {
    return this._info;
  }

  /**
   * Reset the agent's session state.
   *
   * Clears the current {@link sessionId} to `null`. Unlike production agents,
   * there are no external resources to release.
   */
  async close(): Promise<void> {
    this._sessionId = null;
  }
}

/**
 * Create a TestAgent pre-loaded with messages, ready to use in a single expression.
 *
 * @param messages - The sequence of {@link AgentMessage} values the agent will yield.
 * @param config - Optional agent name and metadata overrides.
 * @returns A TestAgent with the messages already set.
 *
 * @example
 * ```typescript
 * const agent = createTestAgent([
 *   { type: 'result', subtype: 'success', output: { label: 'bug' } },
 * ]);
 * ```
 */
export function createTestAgent(messages: AgentMessage[], config?: AgentConfig & { info?: Partial<AgentInfo> }): TestAgent {
  const agent = new TestAgent(config);
  agent.setMessages(messages);
  return agent;
}
