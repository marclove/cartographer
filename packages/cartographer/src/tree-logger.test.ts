import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTreeLogger } from './tree-logger.js';
import { EventEmitter } from './core/event-emitter.js';
import type { TreeEvents } from './types.js';
import { NodeStatus } from './types.js';

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { appendFileSync } from 'node:fs';
const mockAppend = appendFileSync as ReturnType<typeof vi.fn>;

// Parse the lines written to the mock file as JSON.
function writtenEntries(): Record<string, unknown>[] {
  return mockAppend.mock.calls.map(([, line]) => JSON.parse(line as string));
}

function makeNode(name: string, id = `${name}-id`) {
  return { name, id } as any;
}

function makeContext() {
  return {} as any;
}

describe('createTreeLogger', () => {
  let events: EventEmitter<TreeEvents>;

  beforeEach(() => {
    vi.clearAllMocks();
    events = new EventEmitter<TreeEvents>();
  });

  it('returns a cleanup function', () => {
    const stop = createTreeLogger(events, { filePath: 'out.log' });
    expect(typeof stop).toBe('function');
  });

  it('writes node:enter with node name', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('node:enter', { node: makeNode('root'), context: makeContext() });

    const [entry] = writtenEntries();
    expect(entry.seq).toBe(1);
    expect(entry.event).toBe('node:enter');
    expect(entry.node).toBe('root');
    expect(typeof entry.ts).toBe('string');
  });

  it('writes node:exit with status and durationMs', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('node:exit', {
      node: makeNode('action'),
      status: NodeStatus.SUCCESS,
      durationMs: 123,
      context: makeContext(),
    });

    const [entry] = writtenEntries();
    expect(entry.event).toBe('node:exit');
    expect(entry.status).toBe('success');
    expect(entry.durationMs).toBe(123);
  });

  it('writes node:error with message and stack', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    const error = new Error('boom');
    events.emit('node:error', { node: makeNode('bad'), error, context: makeContext() });

    const [entry] = writtenEntries();
    expect(entry.event).toBe('node:error');
    expect(entry.error).toBe('boom');
    expect(typeof entry.stack).toBe('string');
  });

  it('writes agent:prompt', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('agent:prompt', { node: makeNode('ai'), prompt: 'Do something' });

    const [entry] = writtenEntries();
    expect(entry.seq).toBe(1);
    expect(entry.event).toBe('agent:prompt');
    expect(entry.prompt).toBe('Do something');
  });

  it('writes agent:thinking', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('agent:thinking', { node: makeNode('ai'), thinking: 'hmm...' });

    const [entry] = writtenEntries();
    expect(entry.event).toBe('agent:thinking');
    expect(entry.thinking).toBe('hmm...');
  });

  it('writes agent:text', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('agent:text', { node: makeNode('ai'), text: 'Hello world' });

    const [entry] = writtenEntries();
    expect(entry.event).toBe('agent:text');
    expect(entry.text).toBe('Hello world');
  });

  it('writes agent:tool_use', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('agent:tool_use', {
      node: makeNode('ai'),
      tool: 'Bash',
      input: { command: 'ls' },
    });

    const [entry] = writtenEntries();
    expect(entry.event).toBe('agent:tool_use');
    expect(entry.tool).toBe('Bash');
    expect(entry.input).toEqual({ command: 'ls' });
  });

  it('writes agent:response', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('agent:response', { node: makeNode('ai'), result: 'done', cost: 0.01 });

    const [entry] = writtenEntries();
    expect(entry.event).toBe('agent:response');
    expect(entry.result).toBe('done');
    expect(entry.cost).toBe(0.01);
  });

  it('writes agent:error', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('agent:error', {
      node: makeNode('ai'),
      subtype: 'error_max_turns',
      errors: ['Too many turns'],
      cost: 0.05,
    });

    const [entry] = writtenEntries();
    expect(entry.event).toBe('agent:error');
    expect(entry.subtype).toBe('error_max_turns');
    expect(entry.errors).toEqual(['Too many turns']);
    expect(entry.cost).toBe(0.05);
  });

  it('writes agent:tool_progress', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('agent:tool_progress', {
      node: makeNode('ai'),
      toolUseId: 'tu-1',
      toolName: 'Bash',
      elapsedSeconds: 3.5,
    });

    const [entry] = writtenEntries();
    expect(entry.event).toBe('agent:tool_progress');
    expect(entry.toolName).toBe('Bash');
    expect(entry.elapsedSeconds).toBe(3.5);
  });

  it('writes agent:init', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('agent:init', {
      node: makeNode('ai'),
      sessionId: 'sess-1',
      model: 'claude-opus-4-6',
      tools: ['Read'],
      mcpServers: [],
    });

    const [entry] = writtenEntries();
    expect(entry.seq).toBe(1);
    expect(entry.event).toBe('agent:init');
    expect(entry.sessionId).toBe('sess-1');
    expect(entry.model).toBe('claude-opus-4-6');
  });

  it('writes agent:status', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('agent:status', { node: makeNode('ai'), status: 'thinking' });

    const [entry] = writtenEntries();
    expect(entry.event).toBe('agent:status');
    expect(entry.status).toBe('thinking');
  });

  it('writes agent:rate_limit', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    const info = { type: 'tokens', resetsAt: '2026-03-09T12:00:00Z' };
    events.emit('agent:rate_limit', { node: makeNode('ai'), info });

    const [entry] = writtenEntries();
    expect(entry.event).toBe('agent:rate_limit');
    expect(entry.info).toEqual(info);
  });

  it('does NOT log agent:stream', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('agent:stream', { node: makeNode('ai'), event: { type: 'text_delta', text: 'x' } });
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('does NOT log agent:message', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('agent:message', { node: makeNode('ai'), message: { type: 'result' } });
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('does NOT log blackboard:write by default', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('blackboard:write', { key: 'foo', value: 'bar', source: 'action' });
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('logs blackboard:write when logBlackboard is true', () => {
    createTreeLogger(events, { filePath: 'out.log', logBlackboard: true });
    events.emit('blackboard:write', { key: 'foo', value: 42, source: 'action' });

    const [entry] = writtenEntries();
    expect(entry.seq).toBe(1);
    expect(entry.event).toBe('blackboard:write');
    expect(entry.key).toBe('foo');
    expect(entry.value).toBe(42);
  });

  it('increments seq across writes', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('node:enter', { node: makeNode('one'), context: makeContext() });
    events.emit('node:exit', { node: makeNode('one'), status: NodeStatus.SUCCESS, durationMs: 5, context: makeContext() });

    const [first, second] = writtenEntries();
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it('logs strategy:decision by default', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('strategy:decision', {
      composite: makeNode('selector'),
      strategy: 'AgentSelectionStrategy',
      decision: ['b', 'a'],
    });

    const [entry] = writtenEntries();
    expect(entry.event).toBe('strategy:decision');
    expect(entry.composite).toBe('selector');
    expect(entry.strategy).toBe('AgentSelectionStrategy');
  });

  it('does NOT log strategy:decision when logStrategy is false', () => {
    createTreeLogger(events, { filePath: 'out.log', logStrategy: false });
    events.emit('strategy:decision', {
      composite: makeNode('selector'),
      strategy: 'AgentSelectionStrategy',
      decision: [],
    });
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('cleanup removes all listeners', () => {
    const stop = createTreeLogger(events, { filePath: 'out.log' });
    stop();

    events.emit('node:enter', { node: makeNode('root'), context: makeContext() });
    events.emit('agent:prompt', { node: makeNode('ai'), prompt: 'Hi' });
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('uses the provided filePath', () => {
    createTreeLogger(events, { filePath: '/tmp/my-tree.log' });
    events.emit('node:enter', { node: makeNode('root'), context: makeContext() });

    expect(mockAppend).toHaveBeenCalledWith('/tmp/my-tree.log', expect.any(String));
  });

  it('every entry has a ts field', () => {
    createTreeLogger(events, { filePath: 'out.log' });
    events.emit('node:enter', { node: makeNode('root'), context: makeContext() });
    events.emit('node:exit', {
      node: makeNode('root'),
      status: NodeStatus.FAILURE,
      durationMs: 5,
      context: makeContext(),
    });

    const entries = writtenEntries();
    for (const entry of entries) {
      expect(typeof entry.ts).toBe('string');
      expect(() => new Date(entry.ts as string)).not.toThrow();
    }
  });
});
