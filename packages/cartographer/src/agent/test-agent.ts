import { Agent } from './agent.js';
import type { AgentMessage, AgentSendOptions, AgentInfo, AgentConfig } from './agent.js';

/**
 * A controllable Agent for unit and integration tests.
 *
 * Set the messages to yield via `setMessages()`, then call `send()`.
 * Invokes `onMessage` for each message (swallowing errors per spec).
 *
 * Tests that need custom send behavior can override `send()` directly
 * on the instance.
 */
export class TestAgent extends Agent {
  private messages: AgentMessage[] = [];
  private _sessionId: string | null = null;
  private _sessionCounter = 0;
  private _privateSessionId: string | null = null;
  private _info: AgentInfo;

  constructor(config: AgentConfig & { info?: Partial<AgentInfo> } = { name: 'test-agent' }) {
    super(config);
    this._info = { name: config.name, ...config.info };
  }

  setMessages(msgs: AgentMessage[]): void {
    this.messages = msgs;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

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

  getInfo(): AgentInfo {
    return this._info;
  }

  async close(): Promise<void> {
    this._sessionId = null;
  }
}

/**
 * Convenience: create a TestAgent pre-loaded with messages.
 */
export function createTestAgent(messages: AgentMessage[], config?: AgentConfig & { info?: Partial<AgentInfo> }): TestAgent {
  const agent = new TestAgent(config);
  agent.setMessages(messages);
  return agent;
}
