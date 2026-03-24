import { describe, it, expect } from 'vitest';
import { mapSdkMessage } from './claude-sdk-mapper.js';

describe('mapSdkMessage', () => {
  describe('assistant messages', () => {
    it('maps thinking content blocks', () => {
      const result = mapSdkMessage({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'let me think' }] },
      } as any);

      expect(result).toEqual([{ type: 'thinking', content: 'let me think' }]);
    });

    it('maps text content blocks', () => {
      const result = mapSdkMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello world' }] },
      } as any);

      expect(result).toEqual([{ type: 'text', content: 'hello world' }]);
    });

    it('maps tool_use content blocks', () => {
      const result = mapSdkMessage({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'read', input: { path: '/tmp' } }] },
      } as any);

      expect(result).toEqual([{ type: 'tool_use', name: 'read', input: { path: '/tmp' } }]);
    });

    it('maps multiple content blocks into multiple messages', () => {
      const result = mapSdkMessage({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'answer' },
            { type: 'tool_use', name: 'edit', input: {} },
          ],
        },
      } as any);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ type: 'thinking', content: 'hmm' });
      expect(result[1]).toEqual({ type: 'text', content: 'answer' });
      expect(result[2]).toEqual({ type: 'tool_use', name: 'edit', input: {} });
    });

    it('skips unknown block types', () => {
      const result = mapSdkMessage({
        type: 'assistant',
        message: {
          content: [
            { type: 'unknown_block', data: 'ignored' },
            { type: 'text', text: 'kept' },
          ],
        },
      } as any);

      expect(result).toEqual([{ type: 'text', content: 'kept' }]);
    });
  });

  describe('result messages', () => {
    it('maps success with structured_output', () => {
      const result = mapSdkMessage({
        type: 'result',
        subtype: 'success',
        structured_output: { answer: 42 },
        result: 'ignored',
        total_cost_usd: 0.05,
      } as any);

      expect(result).toEqual([{
        type: 'result',
        subtype: 'success',
        output: { answer: 42 },
        cost: 0.05,
      }]);
    });

    it('falls back to JSON-parsing result string', () => {
      const result = mapSdkMessage({
        type: 'result',
        subtype: 'success',
        result: '{"answer":42}',
        total_cost_usd: 0.01,
      } as any);

      expect(result).toEqual([{
        type: 'result',
        subtype: 'success',
        output: { answer: 42 },
        cost: 0.01,
      }]);
    });

    it('uses plain string when JSON parse fails', () => {
      const result = mapSdkMessage({
        type: 'result',
        subtype: 'success',
        result: 'not json',
        total_cost_usd: 0,
      } as any);

      expect(result).toEqual([{
        type: 'result',
        subtype: 'success',
        output: 'not json',
        cost: 0,
      }]);
    });

    it('passes through non-string result directly', () => {
      const result = mapSdkMessage({
        type: 'result',
        subtype: 'success',
        result: 12345,
        total_cost_usd: 0,
      } as any);

      expect(result).toEqual([{
        type: 'result',
        subtype: 'success',
        output: 12345,
        cost: 0,
      }]);
    });

    it('maps error results', () => {
      const result = mapSdkMessage({
        type: 'result',
        subtype: 'error',
        errors: ['something broke'],
        total_cost_usd: 0.02,
      } as any);

      expect(result).toEqual([{
        type: 'result',
        subtype: 'error',
        errors: ['something broke'],
        cost: 0.02,
      }]);
    });
  });

  describe('system messages', () => {
    it('maps init subtype to provider_event/init', () => {
      const msg = { type: 'system', subtype: 'init', session_id: 'sess-1' };
      const result = mapSdkMessage(msg as any);

      expect(result).toEqual([{
        type: 'provider_event',
        subtype: 'init',
        data: msg,
      }]);
    });

    it('maps status subtype to provider_event/status', () => {
      const msg = { type: 'system', subtype: 'status', status: 'running' };
      const result = mapSdkMessage(msg as any);

      expect(result).toEqual([{
        type: 'provider_event',
        subtype: 'status',
        data: msg,
      }]);
    });
  });

  describe('default branch', () => {
    it('maps stream_event to semantic stream type', () => {
      const msg = { type: 'stream_event', event: { delta: 'hi' } };
      const result = mapSdkMessage(msg as any);

      expect(result).toEqual([{ type: 'stream', event: msg }]);
    });

    it('maps tool_progress with normalized field names', () => {
      const result = mapSdkMessage({
        type: 'tool_progress',
        tool_use_id: 't1',
        tool_name: 'read',
        elapsed_time_seconds: 3.5,
      } as any);

      expect(result).toEqual([{
        type: 'provider_event',
        subtype: 'tool_progress',
        data: { toolUseId: 't1', toolName: 'read', elapsedSeconds: 3.5 },
      }]);
    });

    it('maps rate_limit_event to provider_event/rate_limit', () => {
      const result = mapSdkMessage({
        type: 'rate_limit_event',
        rate_limit_info: { retryAfter: 5 },
      } as any);

      expect(result).toEqual([{
        type: 'provider_event',
        subtype: 'rate_limit',
        data: { info: { retryAfter: 5 } },
      }]);
    });

    it('passes through unknown types as provider_event', () => {
      const msg = { type: 'some_future_event', payload: 'data' };
      const result = mapSdkMessage(msg as any);

      expect(result).toEqual([{
        type: 'provider_event',
        subtype: 'some_future_event',
        data: msg,
      }]);
    });
  });
});
