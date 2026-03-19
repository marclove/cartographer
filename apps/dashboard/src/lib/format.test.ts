import { describe, it, expect } from 'vitest';
import { formatTimestamp, formatEventSummary, formatEventDetail } from './format.js';
import type { TimelineEvent } from './stores.svelte.js';

// ---------------------------------------------------------------------------
// Helper — build a TimelineEvent with minimal boilerplate
// ---------------------------------------------------------------------------

function event(
  name: string,
  data: Record<string, unknown>,
): TimelineEvent {
  return { id: 1, event: name, timestamp: Date.now(), data, category: 'test' };
}

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------

describe('formatTimestamp', () => {
  it('formats a timestamp as mm:ss.SSS', () => {
    // 2024-01-01T00:05:30.123Z — minutes=5, seconds=30, ms=123
    const d = new Date(2024, 0, 1, 0, 5, 30, 123);
    expect(formatTimestamp(d.getTime())).toBe('05:30.123');
  });

  it('pads single-digit minutes and seconds', () => {
    const d = new Date(2024, 0, 1, 0, 1, 2, 3);
    expect(formatTimestamp(d.getTime())).toBe('01:02.003');
  });

  it('returns "--:--" for 0', () => {
    expect(formatTimestamp(0)).toBe('--:--');
  });
});

// ---------------------------------------------------------------------------
// formatEventSummary — node events
// ---------------------------------------------------------------------------

describe('formatEventSummary — node events', () => {
  it('node:enter shows the node name', () => {
    const e = event('node:enter', { node: { id: 'n1', name: 'MyAction', type: 'action' } });
    expect(formatEventSummary(e)).toBe('MyAction');
  });

  it('node:exit shows name, status, and duration', () => {
    const e = event('node:exit', {
      node: { id: 'n1', name: 'MyAction', type: 'action' },
      status: 'success',
      durationMs: 42,
    });
    expect(formatEventSummary(e)).toBe('MyAction — SUCCESS 42ms');
  });

  it('node:exit handles missing durationMs', () => {
    const e = event('node:exit', {
      node: { id: 'n1', name: 'MyAction', type: 'action' },
      status: 'failure',
    });
    expect(formatEventSummary(e)).toBe('MyAction — FAILURE ');
  });

  it('node:error shows node name and error message', () => {
    const e = event('node:error', {
      node: { id: 'n1', name: 'MyAction', type: 'action' },
      error: 'timeout exceeded',
    });
    expect(formatEventSummary(e)).toBe('MyAction: timeout exceeded');
  });

  it('node:error uses "unknown error" when error field is missing', () => {
    const e = event('node:error', {
      node: { id: 'n1', name: 'MyAction', type: 'action' },
    });
    expect(formatEventSummary(e)).toBe('MyAction: unknown error');
  });
});

// ---------------------------------------------------------------------------
// formatEventSummary — agent events
// ---------------------------------------------------------------------------

describe('formatEventSummary — agent events', () => {
  it('agent:thinking shows the text', () => {
    const e = event('agent:thinking', { text: 'Let me think...' });
    expect(formatEventSummary(e)).toBe('Let me think...');
  });

  it('agent:text shows the text', () => {
    const e = event('agent:text', { text: 'Hello world' });
    expect(formatEventSummary(e)).toBe('Hello world');
  });

  it('agent:tool_use shows the tool name', () => {
    const e = event('agent:tool_use', { tool: 'read_file' });
    expect(formatEventSummary(e)).toBe('read_file');
  });

  it('agent:response shows cost when present', () => {
    const e = event('agent:response', { cost: 0.0123 });
    expect(formatEventSummary(e)).toBe('cost: $0.0123');
  });

  it('agent:response shows "completed" when cost is absent', () => {
    const e = event('agent:response', { result: 'done' });
    expect(formatEventSummary(e)).toBe('completed');
  });

  it('agent:init shows model, tool count, and MCP server count', () => {
    const e = event('agent:init', {
      model: 'claude-sonnet-4-20250514',
      tools: ['a', 'b', 'c'],
      mcpServers: ['s1'],
    });
    expect(formatEventSummary(e)).toBe('model: claude-sonnet-4-20250514, 3 tools, 1 MCP servers');
  });

  it('agent:init defaults to 0 when tools/mcpServers are missing', () => {
    const e = event('agent:init', { model: 'opus' });
    expect(formatEventSummary(e)).toBe('model: opus, 0 tools, 0 MCP servers');
  });

  it('agent:status shows the status', () => {
    const e = event('agent:status', { status: 'processing' });
    expect(formatEventSummary(e)).toBe('processing');
  });

  it('agent:prompt shows the prompt text', () => {
    const e = event('agent:prompt', { prompt: 'Analyze this data' });
    expect(formatEventSummary(e)).toBe('Analyze this data');
  });

  it('agent:tool_progress shows tool name and elapsed time', () => {
    const e = event('agent:tool_progress', { toolName: 'search', elapsedSeconds: 3 });
    expect(formatEventSummary(e)).toBe('search 3s');
  });

  it('agent:tool_progress omits elapsed when missing', () => {
    const e = event('agent:tool_progress', { toolName: 'search' });
    expect(formatEventSummary(e)).toBe('search ');
  });

  it('agent:rate_limit shows stringified info', () => {
    const e = event('agent:rate_limit', { info: { retryAfter: 5 } });
    expect(formatEventSummary(e)).toBe('{"retryAfter":5}');
  });

  it('agent:error shows subtype and errors', () => {
    const e = event('agent:error', { subtype: 'tool_error', errors: ['bad input', 'timeout'] });
    expect(formatEventSummary(e)).toBe('tool_error: bad input, timeout');
  });
});

// ---------------------------------------------------------------------------
// formatEventSummary — tree events
// ---------------------------------------------------------------------------

describe('formatEventSummary — tree events', () => {
  it('tree:tick shows tree name, status, and duration', () => {
    const e = event('tree:tick', { tree: 'MyTree', status: 'success', durationMs: 150 });
    expect(formatEventSummary(e)).toBe('MyTree — SUCCESS (150ms)');
  });

  it('tree:tick:skipped shows overlap message', () => {
    const e = event('tree:tick:skipped', { timestamp: 1234567890 });
    expect(formatEventSummary(e)).toBe('tick skipped (overlap)');
  });

  it('tree:reset shows tree name', () => {
    const e = event('tree:reset', { tree: 'MyTree' });
    expect(formatEventSummary(e)).toBe('MyTree');
  });

  it('tree:abort shows tree name', () => {
    const e = event('tree:abort', { tree: 'MyTree' });
    expect(formatEventSummary(e)).toBe('MyTree');
  });
});

// ---------------------------------------------------------------------------
// formatEventSummary — other events
// ---------------------------------------------------------------------------

describe('formatEventSummary — other events', () => {
  it('blackboard:keys shows key count', () => {
    const e = event('blackboard:keys', { keys: ['a', 'b', 'c'] });
    expect(formatEventSummary(e)).toBe('3 keys');
  });

  it('blackboard:keys shows singular for one key', () => {
    const e = event('blackboard:keys', { keys: ['only'] });
    expect(formatEventSummary(e)).toBe('1 key');
  });

  it('blackboard:read shows key and value on hit', () => {
    const e = event('blackboard:read', { key: 'counter', value: 42, hit: true });
    expect(formatEventSummary(e)).toBe('counter = 42');
  });

  it('blackboard:read shows (miss) when hit is false', () => {
    const e = event('blackboard:read', { key: 'missing', value: undefined, hit: false });
    expect(formatEventSummary(e)).toBe('missing (miss)');
  });

  it('blackboard:write shows key = value', () => {
    const e = event('blackboard:write', { key: 'counter', value: 42 });
    expect(formatEventSummary(e)).toBe('counter = 42');
  });

  it('blackboard:write handles string values', () => {
    const e = event('blackboard:write', { key: 'name', value: 'alice' });
    expect(formatEventSummary(e)).toBe('name = "alice"');
  });

  it('strategy:decision shows the strategy name', () => {
    const e = event('strategy:decision', { strategy: 'priority-based' });
    expect(formatEventSummary(e)).toBe('priority-based');
  });

  it('unknown event falls back to JSON.stringify', () => {
    const e = event('snapshot', { custom: 'data' });
    expect(formatEventSummary(e)).toBe('{"custom":"data"}');
  });
});

// ---------------------------------------------------------------------------
// formatEventDetail
// ---------------------------------------------------------------------------

describe('formatEventDetail', () => {
  it('returns pretty-printed JSON of event data', () => {
    const e = event('node:enter', { node: { id: 'n1', name: 'Test' } });
    const detail = formatEventDetail(e);
    expect(detail).toBe(JSON.stringify({ node: { id: 'n1', name: 'Test' } }, null, 2));
  });
});
