import { describe, it, expect } from 'vitest';
import type { AgentMessage } from './agent.js';
import { isThinkingCapable, isStreamCapable } from './agent.js';
import { TestAgent } from './test-agent.js';

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

    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual(expect.objectContaining({ type: 'session_start' }));
    expect(messages[1]).toEqual({ type: 'text', content: 'hello' });
    expect(messages[2]).toEqual({ type: 'result', subtype: 'success', output: 'done' });
  });

  it('sessionId is set after send', async () => {
    const agent = new TestAgent({ name: 'test' });
    agent.setMessages([{ type: 'result', subtype: 'success', output: 'ok' }]);

    for await (const _ of agent.send('prompt')) { /* consume */ }

    expect(agent.sessionId).toEqual(expect.any(String));
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

    expect(messages).toHaveLength(3); // session_start + 2 configured messages
  });

  it('getInfo() returns agent metadata', () => {
    const agent = new TestAgent({ name: 'my-agent', info: { model: 'test-model' } });
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

  describe('isThinkingCapable', () => {
    it('returns false for a plain Agent', () => {
      const agent = new TestAgent({ name: 'plain' });
      expect(isThinkingCapable(agent)).toBe(false);
    });

    it('returns true for an agent with supportsThinking: true', () => {
      const agent = Object.assign(new TestAgent({ name: 'thinker' }), {
        supportsThinking: true as const,
      });
      expect(isThinkingCapable(agent)).toBe(true);
    });

    it('returns false when supportsThinking is not true', () => {
      const agent = Object.assign(new TestAgent({ name: 'nope' }), {
        supportsThinking: false,
      });
      expect(isThinkingCapable(agent)).toBe(false);
    });
  });

  describe('isStreamCapable', () => {
    it('returns false for a plain Agent', () => {
      const agent = new TestAgent({ name: 'plain' });
      expect(isStreamCapable(agent)).toBe(false);
    });

    it('returns true for an agent with supportsStreaming: true', () => {
      const agent = Object.assign(new TestAgent({ name: 'streamer' }), {
        supportsStreaming: true as const,
      });
      expect(isStreamCapable(agent)).toBe(true);
    });
  });
});
