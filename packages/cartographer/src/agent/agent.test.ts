import { describe, it, expect } from 'vitest';
import { Agent } from './agent.js';
import type { AgentMessage, AgentSendOptions, AgentInfo } from './agent.js';

class TestAgent extends Agent {
  private messages: AgentMessage[] = [];
  private _sessionId: string | null = null;

  setMessages(msgs: AgentMessage[]): void {
    this.messages = msgs;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  async *send(prompt: string, options?: AgentSendOptions): AsyncIterable<AgentMessage> {
    this._sessionId = 'test-session-1';
    for (const msg of this.messages) {
      if (options?.onMessage) {
        try {
          options.onMessage(msg);
        } catch {
          // onMessage errors are swallowed per spec
        }
      }
      yield msg;
    }
  }

  getInfo(): AgentInfo {
    return { name: this.name, model: 'test-model' };
  }

  async close(): Promise<void> {
    this._sessionId = null;
  }
}

describe('Agent', () => {
  it('stores the name from config', () => {
    const agent = new TestAgent({ name: 'test-agent' });
    expect(agent.name).toBe('test-agent');
  });

  it('sessionId is null before first send', () => {
    const agent = new TestAgent({ name: 'test' });
    expect(agent.sessionId).toBeNull();
  });

  it('send() returns an async iterable of AgentMessages', async () => {
    const agent = new TestAgent({ name: 'test' });
    agent.setMessages([
      { type: 'text', content: 'hello' },
      { type: 'result', subtype: 'success', output: 'done' },
    ]);

    const messages: AgentMessage[] = [];
    for await (const msg of agent.send('prompt')) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ type: 'text', content: 'hello' });
    expect(messages[1]).toEqual({ type: 'result', subtype: 'success', output: 'done' });
  });

  it('sessionId is set after send', async () => {
    const agent = new TestAgent({ name: 'test' });
    agent.setMessages([{ type: 'result', subtype: 'success', output: 'ok' }]);

    for await (const _ of agent.send('prompt')) { /* consume */ }

    expect(agent.sessionId).toBe('test-session-1');
  });

  it('onMessage callback is invoked for each message', async () => {
    const agent = new TestAgent({ name: 'test' });
    agent.setMessages([
      { type: 'thinking', content: 'hmm' },
      { type: 'result', subtype: 'success', output: 'ok' },
    ]);

    const received: AgentMessage[] = [];
    for await (const _ of agent.send('prompt', {
      onMessage: (msg) => received.push(msg),
    })) { /* consume */ }

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe('thinking');
  });

  it('onMessage errors do not crash iteration', async () => {
    const agent = new TestAgent({ name: 'test' });
    agent.setMessages([
      { type: 'text', content: 'hello' },
      { type: 'result', subtype: 'success', output: 'ok' },
    ]);

    const messages: AgentMessage[] = [];
    for await (const msg of agent.send('prompt', {
      onMessage: () => { throw new Error('handler error'); },
    })) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(2);
  });

  it('getInfo() returns agent metadata', () => {
    const agent = new TestAgent({ name: 'my-agent' });
    const info = agent.getInfo();
    expect(info.name).toBe('my-agent');
    expect(info.model).toBe('test-model');
  });

  it('close() clears sessionId', async () => {
    const agent = new TestAgent({ name: 'test' });
    agent.setMessages([{ type: 'result', subtype: 'success', output: 'ok' }]);
    for await (const _ of agent.send('prompt')) { /* consume */ }
    expect(agent.sessionId).not.toBeNull();

    await agent.close();
    expect(agent.sessionId).toBeNull();
  });
});
