import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryBlackboard } from '../core/blackboard.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => handler),
}));

import { ClaudeSDKAgent } from './claude-sdk-agent.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentMessage } from './agent.js';

const mockQuery = vi.mocked(query);

async function* mockMessages(messages: unknown[]) {
  for (const msg of messages) {
    yield msg;
  }
}

function collectMessages(iterable: AsyncIterable<AgentMessage>): Promise<AgentMessage[]> {
  return (async () => {
    const msgs: AgentMessage[] = [];
    for await (const msg of iterable) {
      msgs.push(msg);
    }
    return msgs;
  })();
}

describe('ClaudeSDKAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('validates reserved "blackboard" MCP server name', () => {
      expect(() => new ClaudeSDKAgent({
        name: 'test',
        mcpServers: { blackboard: { type: 'stdio', command: 'echo' } } as any,
      })).toThrow(/blackboard.*reserved/i);
    });

    it('accepts config without blackboard MCP server', () => {
      expect(() => new ClaudeSDKAgent({ name: 'test' })).not.toThrow();
    });
  });

  describe('send()', () => {
    it('returns an async iterable that yields AgentMessages', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
        { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      const msgs = await collectMessages(agent.send('prompt'));

      expect(msgs).toContainEqual({ type: 'text', content: 'hello' });
      expect(msgs).toContainEqual(expect.objectContaining({ type: 'result', subtype: 'success' }));
    });

    it('maps thinking content blocks', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } },
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      const msgs = await collectMessages(agent.send('prompt'));

      expect(msgs).toContainEqual({ type: 'thinking', content: 'hmm' });
    });

    it('maps tool_use content blocks', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'read', input: { path: '/tmp' } }] } },
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      const msgs = await collectMessages(agent.send('prompt'));

      expect(msgs).toContainEqual({ type: 'tool_use', name: 'read', input: { path: '/tmp' } });
    });

    it('maps result error messages', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'result', subtype: 'error', errors: ['bad'], total_cost_usd: 0.01 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      const msgs = await collectMessages(agent.send('prompt'));

      expect(msgs).toContainEqual(expect.objectContaining({
        type: 'result',
        subtype: 'error',
        errors: ['bad'],
      }));
    });

    it('maps provider-specific events (stream, tool_progress, system, rate_limit)', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'stream_event', event: { delta: 'hi' } },
        { type: 'tool_progress', tool_use_id: 't1', tool_name: 'read', elapsed_time_seconds: 1 },
        { type: 'system', subtype: 'init', session_id: 's1' },
        { type: 'rate_limit_event', rate_limit_info: { retryAfter: 5 } },
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      const msgs = await collectMessages(agent.send('prompt'));

      const providerEvents = msgs.filter((m) => m.type === 'provider_event');
      // stream_event + tool_progress + init (from system) + rate_limit = 4
      expect(providerEvents.length).toBeGreaterThanOrEqual(4);
    });

    it('prefers structured_output for result when outputSchema is set', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'result', subtype: 'success', structured_output: { answer: 42 }, total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      const msgs = await collectMessages(agent.send('prompt', {
        outputSchema: { type: 'object', properties: { answer: { type: 'number' } } },
      }));

      const result = msgs.find((m) => m.type === 'result' && m.subtype === 'success');
      expect(result).toBeDefined();
      expect((result as any).output).toEqual({ answer: 42 });
    });

    it('falls back to JSON-parsing result string when structured_output is absent', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'result', subtype: 'success', result: '{"answer":42}', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      const msgs = await collectMessages(agent.send('prompt', {
        outputSchema: { type: 'object', properties: { answer: { type: 'number' } } },
      }));

      const result = msgs.find((m) => m.type === 'result' && m.subtype === 'success');
      expect((result as any).output).toEqual({ answer: 42 });
    });

    it('strips $schema from outputSchema before passing to SDK', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      await collectMessages(agent.send('prompt', {
        outputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' },
      }));

      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(callArgs.options.outputFormat.schema).not.toHaveProperty('$schema');
      expect(callArgs.options.outputFormat.schema).toHaveProperty('type', 'object');
    });

    it('passes prompt as a string to query()', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      await collectMessages(agent.send('hello world'));

      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(callArgs.prompt).toBe('hello world');
    });

    it('does not override persistSession (SDK default true enables resume)', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      await collectMessages(agent.send('prompt'));

      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(callArgs.options.persistSession).toBeUndefined();
    });

    it('creates a fresh query() call for each send()', async () => {
      mockQuery
        .mockReturnValueOnce(mockMessages([
          { type: 'result', subtype: 'success', result: 'first', total_cost_usd: 0 },
        ]) as any)
        .mockReturnValueOnce(mockMessages([
          { type: 'result', subtype: 'success', result: 'second', total_cost_usd: 0 },
        ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      await collectMessages(agent.send('first'));
      await collectMessages(agent.send('second'));

      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe('onMessage', () => {
    it('invokes onMessage for each yielded AgentMessage (excluding session_start)', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'system', subtype: 'init', session_id: 'sess-1' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      const received: AgentMessage[] = [];

      await collectMessages(agent.send('prompt', {
        onMessage: (msg) => received.push(msg),
      }));

      // onMessage should be called for provider_event (init), text, and result
      // but NOT for session_start
      expect(received.some((m) => m.type === 'session_start')).toBe(false);
      expect(received.some((m) => m.type === 'provider_event')).toBe(true);
      expect(received.some((m) => m.type === 'text')).toBe(true);
    });

    it('swallows errors thrown by onMessage and emits provider_event:onMessage_error', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      const msgs = await collectMessages(agent.send('prompt', {
        onMessage: () => { throw new Error('boom'); },
      }));

      // Should still yield messages despite onMessage error
      expect(msgs.some((m) => m.type === 'text')).toBe(true);
      // Should emit a provider_event with subtype onMessage_error
      const errorEvents = msgs.filter(
        (m) => m.type === 'provider_event' && (m as any).subtype === 'onMessage_error',
      );
      expect(errorEvents.length).toBeGreaterThan(0);
      expect((errorEvents[0] as any).data).toBe('boom');
    });
  });

  describe('blackboard', () => {
    it('creates blackboard MCP server when blackboard is provided', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      const blackboard = new InMemoryBlackboard();

      await collectMessages(agent.send('prompt', { blackboard }));

      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(callArgs.options.mcpServers).toHaveProperty('blackboard');
      expect(callArgs.options.allowedTools).toContain('mcp__blackboard__*');
    });
  });

  describe('sessionId', () => {
    it('is null before first send', () => {
      const agent = new ClaudeSDKAgent({ name: 'test' });
      expect(agent.sessionId).toBeNull();
    });

    it('is populated from SDK init message', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'system', subtype: 'init', session_id: 'sess-123' },
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      await collectMessages(agent.send('prompt'));

      expect(agent.sessionId).toBe('sess-123');
    });

    it('yields session_start before provider_event for init messages', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'system', subtype: 'init', session_id: 'sess-456' },
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      const msgs = await collectMessages(agent.send('prompt'));

      // session_start should come before the init provider_event
      const sessionIdx = msgs.findIndex((m) => m.type === 'session_start');
      const initIdx = msgs.findIndex((m) => m.type === 'provider_event' && (m as any).subtype === 'init');

      expect(sessionIdx).toBeGreaterThanOrEqual(0);
      expect(initIdx).toBeGreaterThan(sessionIdx);
      expect((msgs[sessionIdx] as any).sessionId).toBe('sess-456');
    });
  });

  describe('session support', () => {
    it('resumes private session on second send() without session options', async () => {
      mockQuery
        .mockReturnValueOnce(mockMessages([
          { type: 'system', subtype: 'init', session_id: 'private-sess-1' },
          { type: 'result', subtype: 'success', result: 'first', total_cost_usd: 0 },
        ]) as any)
        .mockReturnValueOnce(mockMessages([
          { type: 'system', subtype: 'init', session_id: 'private-sess-1' },
          { type: 'result', subtype: 'success', result: 'second', total_cost_usd: 0 },
        ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      await collectMessages(agent.send('first'));
      await collectMessages(agent.send('second'));

      // First send: no resume (no prior session)
      const firstCallArgs = mockQuery.mock.calls[0][0] as any;
      expect(firstCallArgs.options.resume).toBeUndefined();

      // Second send: should resume the private session
      const secondCallArgs = mockQuery.mock.calls[1][0] as any;
      expect(secondCallArgs.options.resume).toBe('private-sess-1');
    });

    it('resumes named session when session.id is provided', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'system', subtype: 'init', session_id: 'named-sess-42' },
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      await collectMessages(agent.send('prompt', {
        session: { id: 'named-sess-42' },
      }));

      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(callArgs.options.resume).toBe('named-sess-42');
    });

    it('creates new named session when session options are provided without id', async () => {
      // First send without session options creates a private session
      mockQuery
        .mockReturnValueOnce(mockMessages([
          { type: 'system', subtype: 'init', session_id: 'private-sess' },
          { type: 'result', subtype: 'success', result: 'first', total_cost_usd: 0 },
        ]) as any)
        .mockReturnValueOnce(mockMessages([
          { type: 'system', subtype: 'init', session_id: 'new-named-sess' },
          { type: 'result', subtype: 'success', result: 'second', total_cost_usd: 0 },
        ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      await collectMessages(agent.send('first'));

      // Second send with session={} (no id) should NOT resume the private session
      await collectMessages(agent.send('second', { session: {} }));

      const secondCallArgs = mockQuery.mock.calls[1][0] as any;
      expect(secondCallArgs.options.resume).toBeUndefined();
    });

    it('does not store session id as private when using named sessions', async () => {
      mockQuery
        .mockReturnValueOnce(mockMessages([
          { type: 'system', subtype: 'init', session_id: 'named-sess' },
          { type: 'result', subtype: 'success', result: 'first', total_cost_usd: 0 },
        ]) as any)
        .mockReturnValueOnce(mockMessages([
          { type: 'result', subtype: 'success', result: 'second', total_cost_usd: 0 },
        ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });

      // Send with named session
      await collectMessages(agent.send('first', { session: { id: 'named-sess' } }));

      // Send without session — should NOT resume the named session
      await collectMessages(agent.send('second'));

      const secondCallArgs = mockQuery.mock.calls[1][0] as any;
      expect(secondCallArgs.options.resume).toBeUndefined();
    });

    it('forks a session when session.fork is true', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'system', subtype: 'init', session_id: 'forked-sess' },
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      await collectMessages(agent.send('prompt', {
        session: { id: 'original-sess', fork: true },
      }));

      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(callArgs.options.resume).toBe('original-sess');
      expect(callArgs.options.forkSession).toBe(true);
    });

    it('does not set forkSession without an id to resume', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      await collectMessages(agent.send('prompt', {
        session: { fork: true },
      }));

      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(callArgs.options.forkSession).toBeUndefined();
    });
  });

  describe('getInfo()', () => {
    it('returns name and model from config', () => {
      const agent = new ClaudeSDKAgent({ name: 'my-agent', model: 'claude-haiku-4-5' });
      const info = agent.getInfo();
      expect(info.name).toBe('my-agent');
      expect(info.model).toBe('claude-haiku-4-5');
    });

    it('returns allowedTools and mcpServers from config', () => {
      const agent = new ClaudeSDKAgent({
        name: 'my-agent',
        allowedTools: ['read', 'write'],
        mcpServers: { tools: { type: 'stdio', command: 'echo' } } as any,
      });
      const info = agent.getInfo();
      expect(info.tools).toEqual(['read', 'write']);
      expect(info.mcpServers).toEqual(['tools']);
    });
  });

  describe('abort signal → interrupt', () => {
    it('passes signal through to query options for SDK-level abort handling', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      const ac = new AbortController();

      await collectMessages(agent.send('prompt', { signal: ac.signal }));

      // In query-per-send model, the signal is passed through buildQueryOptions
      // so the SDK can handle abort natively
      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(callArgs.options.signal).toBe(ac.signal);
    });
  });

  describe('close()', () => {
    it('subsequent send() throws after close', async () => {
      const agent = new ClaudeSDKAgent({ name: 'test' });
      await agent.close();

      expect(() => agent.send('prompt')).toThrow(/closed/i);
    });

    it('calls close() on active query instance', async () => {
      const closeSpy = vi.fn();
      let resolveBlock!: (msg: unknown) => void;
      const blockingPromise = new Promise((resolve) => { resolveBlock = resolve; });

      async function* neverEnds() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
        yield await blockingPromise;
      }

      const iterable = neverEnds();
      Object.assign(iterable, { close: closeSpy });
      mockQuery.mockReturnValue(iterable as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });

      // Start iterating (query becomes active). Kick off a concurrent
      // next() so the inner generator advances to the blocking promise.
      const asyncIter = agent.send('prompt')[Symbol.asyncIterator]();
      await asyncIter.next(); // consume first (text) message

      // Start pulling the second message — this drives the inner generator
      // into the blocking promise so _activeQuery stays assigned
      const pendingNext = asyncIter.next();

      // Close the agent while the query is still active
      await agent.close();
      expect(closeSpy).toHaveBeenCalledOnce();

      // Clean up: resolve the blocking promise so the generator exits
      resolveBlock({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 });
      await pendingNext;
    });
  });

  describe('elicitation', () => {
    it('defaults permissionMode to "default"', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      await collectMessages(agent.send('prompt'));

      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(callArgs.options.permissionMode).toBe('default');
    });

    it('always provides an onElicitation handler', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      await collectMessages(agent.send('prompt'));

      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(callArgs.options.onElicitation).toBeTypeOf('function');
    });

    it('auto-decline calls onMessage with elicitation_declined when no user handler', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const received: AgentMessage[] = [];
      const agent = new ClaudeSDKAgent({ name: 'test' });
      await collectMessages(agent.send('prompt', {
        onMessage: (msg) => received.push(msg),
      }));

      // Get the onElicitation handler and call it
      const callArgs = mockQuery.mock.calls[0][0] as any;
      const handler = callArgs.options.onElicitation;
      const result = await handler({ type: 'elicitation', message: 'confirm?' }, {});

      expect(result).toEqual({ action: 'decline' });
      expect(received).toContainEqual(expect.objectContaining({
        type: 'provider_event',
        subtype: 'elicitation_declined',
      }));
    });
  });
});
