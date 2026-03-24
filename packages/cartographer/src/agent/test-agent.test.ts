import { describe, it, expect } from 'vitest';
import { TestAgent, createTestAgent } from './test-agent.js';
import type { AgentMessage } from './agent.js';

describe('TestAgent', () => {
  describe('session_start emission', () => {
    it('emits session_start as the first message', async () => {
      const agent = createTestAgent([
        { type: 'result', subtype: 'success', output: 'done' },
      ]);
      const messages: AgentMessage[] = [];
      for await (const msg of agent.send('hello')) {
        messages.push(msg);
      }
      expect(messages[0]).toEqual(
        expect.objectContaining({ type: 'session_start' }),
      );
      expect((messages[0] as any).sessionId).toEqual(expect.any(String));
    });

    it('generates a stable private session ID across sends without session options', async () => {
      const agent = createTestAgent([
        { type: 'result', subtype: 'success', output: 'done' },
      ]);

      const first: AgentMessage[] = [];
      for await (const msg of agent.send('hello')) first.push(msg);

      const second: AgentMessage[] = [];
      for await (const msg of agent.send('hello again')) second.push(msg);

      const id1 = (first[0] as any).sessionId;
      const id2 = (second[0] as any).sessionId;
      expect(id1).toBe(id2); // same private session
    });
  });

  describe('session options', () => {
    it('uses the provided session ID when resuming', async () => {
      const agent = createTestAgent([
        { type: 'result', subtype: 'success', output: 'done' },
      ]);
      const messages: AgentMessage[] = [];
      for await (const msg of agent.send('hello', { session: { id: 'existing-session' } })) {
        messages.push(msg);
      }
      expect((messages[0] as any).sessionId).toBe('existing-session');
    });

    it('generates a new session ID when forking', async () => {
      const agent = createTestAgent([
        { type: 'result', subtype: 'success', output: 'done' },
      ]);
      const messages: AgentMessage[] = [];
      for await (const msg of agent.send('hello', { session: { id: 'parent-session', fork: true } })) {
        messages.push(msg);
      }
      const sessionId = (messages[0] as any).sessionId;
      expect(sessionId).not.toBe('parent-session');
      expect(sessionId).toEqual(expect.any(String));
    });

    it('generates a new session ID when session options have no id (first use of named session)', async () => {
      const agent = createTestAgent([
        { type: 'result', subtype: 'success', output: 'done' },
      ]);
      const messages: AgentMessage[] = [];
      for await (const msg of agent.send('hello', { session: {} })) {
        messages.push(msg);
      }
      expect((messages[0] as any).sessionId).toEqual(expect.any(String));
    });

    it('does not change the private session ID when using explicit session options', async () => {
      const agent = createTestAgent([
        { type: 'result', subtype: 'success', output: 'done' },
      ]);

      const first: AgentMessage[] = [];
      for await (const msg of agent.send('hello')) first.push(msg);
      const privateId = (first[0] as any).sessionId;

      for await (const _msg of agent.send('hello', { session: { id: 'other' } })) {}

      const third: AgentMessage[] = [];
      for await (const msg of agent.send('hello')) third.push(msg);
      expect((third[0] as any).sessionId).toBe(privateId);
    });
  });

  describe('onMessage callback', () => {
    it('does not invoke onMessage for session_start messages', async () => {
      const agent = createTestAgent([
        { type: 'result', subtype: 'success', output: 'done' },
      ]);
      const received: AgentMessage[] = [];
      for await (const _msg of agent.send('hello', {
        onMessage: (msg) => received.push(msg),
      })) {}
      expect(received.every(m => m.type !== 'session_start')).toBe(true);
    });
  });
});
