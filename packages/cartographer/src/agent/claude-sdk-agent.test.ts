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
  });

  describe('onMessage', () => {
    it('invokes onMessage for each yielded AgentMessage', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      const received: AgentMessage[] = [];

      await collectMessages(agent.send('prompt', {
        onMessage: (msg) => received.push(msg),
      }));

      expect(received.length).toBeGreaterThanOrEqual(2);
      expect(received.some((m) => m.type === 'text')).toBe(true);
    });

    it('swallows errors thrown by onMessage', async () => {
      mockQuery.mockReturnValue(mockMessages([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 },
      ]) as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      const msgs = await collectMessages(agent.send('prompt', {
        onMessage: () => { throw new Error('boom'); },
      }));

      // Should still yield messages despite onMessage error
      expect(msgs.length).toBeGreaterThanOrEqual(1);
      // Should emit a provider_event for the error
      expect(msgs.some((m) => m.type === 'provider_event' && (m as any).subtype === 'onMessage_error')).toBe(true);
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
    it('calls queryInstance.interrupt() when active turn signal fires', async () => {
      const interruptSpy = vi.fn();
      let resolveBlock!: (msg: unknown) => void;

      async function* blocksAfterFirst() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
        yield await new Promise((resolve) => { resolveBlock = resolve; });
      }

      const iterable = blocksAfterFirst();
      Object.assign(iterable, { interrupt: interruptSpy });
      mockQuery.mockReturnValue(iterable as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      const ac = new AbortController();

      const asyncIter = agent.send('prompt', { signal: ac.signal })[Symbol.asyncIterator]();

      // Consume first message — demux loop activates the turn and wires the signal
      await asyncIter.next();

      // Abort — should forward to SDK via interrupt()
      ac.abort();
      expect(interruptSpy).toHaveBeenCalledOnce();

      // Clean up
      resolveBlock({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 });
      await asyncIter.next();
    });

    it('does not call interrupt() after turn completes normally', async () => {
      const interruptSpy = vi.fn();

      async function* yieldsAll() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
        yield { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 };
      }

      const iterable = yieldsAll();
      Object.assign(iterable, { interrupt: interruptSpy });
      mockQuery.mockReturnValue(iterable as any);

      const agent = new ClaudeSDKAgent({ name: 'test' });
      const ac = new AbortController();

      // Consume all messages — turn completes, signal listener cleaned up
      await collectMessages(agent.send('prompt', { signal: ac.signal }));

      // Aborting after completion should not call interrupt
      ac.abort();
      expect(interruptSpy).not.toHaveBeenCalled();
    });
  });

  describe('close()', () => {
    it('subsequent send() throws after close', async () => {
      const agent = new ClaudeSDKAgent({ name: 'test' });
      await agent.close();

      expect(() => agent.send('prompt')).toThrow(/closed/i);
    });
  });
});
