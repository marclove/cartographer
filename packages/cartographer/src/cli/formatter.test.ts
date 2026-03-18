import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFormatter } from './formatter.js';
import { EventEmitter } from '../core/event-emitter.js';
import type { TreeEvents, ModelUsage } from '../types.js';
import { NodeStatus } from '../types.js';

function makeNode(name: string, id = `${name}-id`, constructorName = 'ActionNode') {
  const node = { name, id, children: [] } as any;
  Object.defineProperty(node, 'constructor', { value: { name: constructorName } });
  return node;
}

function makeContext() {
  return {} as any;
}

describe('createFormatter', () => {
  let events: EventEmitter<TreeEvents>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    events = new EventEmitter<TreeEvents>();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  function stdoutLines(): string[] {
    return stdoutSpy.mock.calls.map(([line]) => String(line));
  }

  // --- Text mode ---

  describe('text mode (default)', () => {
    it('prints node:enter with type and name', () => {
      createFormatter(events);
      events.emit('node:enter', { node: makeNode('greet'), context: makeContext() });

      const lines = stdoutLines();
      expect(lines[0]).toContain('▶');
      expect(lines[0]).toContain('[action]');
      expect(lines[0]).toContain('greet');
    });

    it('prints node:exit with status symbol and duration', () => {
      createFormatter(events);
      const node = makeNode('greet');
      events.emit('node:enter', { node, context: makeContext() });
      events.emit('node:exit', { node, status: NodeStatus.SUCCESS, context: makeContext(), durationMs: 123.456 });

      const lines = stdoutLines();
      expect(lines[1]).toContain('✓');
      expect(lines[1]).toContain('123ms');
    });

    it('uses ✗ for failure status', () => {
      createFormatter(events);
      const node = makeNode('greet');
      events.emit('node:enter', { node, context: makeContext() });
      events.emit('node:exit', { node, status: NodeStatus.FAILURE, context: makeContext(), durationMs: 50 });

      const lines = stdoutLines();
      expect(lines[1]).toContain('✗');
    });

    it('uses … for running status', () => {
      createFormatter(events);
      const node = makeNode('greet');
      events.emit('node:enter', { node, context: makeContext() });
      events.emit('node:exit', { node, status: NodeStatus.RUNNING, context: makeContext(), durationMs: 50 });

      const lines = stdoutLines();
      expect(lines[1]).toContain('…');
    });

    it('indents nested nodes', () => {
      createFormatter(events);
      const parent = makeNode('seq', 'seq-id', 'SequenceNode');
      const child = makeNode('action1');
      (parent as any).children = [child];

      events.emit('node:enter', { node: parent, context: makeContext() });
      events.emit('node:enter', { node: child, context: makeContext() });

      const lines = stdoutLines();
      // Parent has no indentation, child has 2-space indentation
      expect(lines[0]).toMatch(/^▶/);
      expect(lines[1]).toMatch(/^ {2}▶/);
    });

    it('indents parallel children at the same depth', () => {
      createFormatter(events);
      const parent = makeNode('par', 'par-id', 'ParallelNode');
      const childA = makeNode('a');
      const childB = makeNode('b');
      const childC = makeNode('c');
      (parent as any).children = [childA, childB, childC];

      events.emit('node:enter', { node: parent, context: makeContext() });
      // All three enter before any exit (concurrent)
      events.emit('node:enter', { node: childA, context: makeContext() });
      events.emit('node:enter', { node: childB, context: makeContext() });
      events.emit('node:enter', { node: childC, context: makeContext() });

      const lines = stdoutLines();
      expect(lines[0]).toMatch(/^▶/);            // parent at depth 0
      expect(lines[1]).toMatch(/^ {2}▶.*\ba\b/); // child a at depth 1
      expect(lines[2]).toMatch(/^ {2}▶.*\bb\b/); // child b at depth 1
      expect(lines[3]).toMatch(/^ {2}▶.*\bc\b/); // child c at depth 1
    });

    it('prints tree:tick summary', () => {
      createFormatter(events);
      events.emit('tree:tick', { tree: 'my-tree', status: NodeStatus.SUCCESS, durationMs: 1234 });

      const lines = stdoutLines();
      const summaryLine = lines.find(l => l.includes('Tree:'));
      expect(summaryLine).toContain('my-tree');
      expect(summaryLine).toContain('SUCCESS');
      expect(summaryLine).toContain('1234ms');
    });

    it('does not print agent:thinking without verbose', () => {
      createFormatter(events);
      events.emit('agent:thinking', { node: makeNode('agent1'), thinking: 'deep thoughts' });

      expect(stdoutLines()).toHaveLength(0);
    });

    it('prints agent:thinking with verbose', () => {
      createFormatter(events, { verbose: true });
      events.emit('agent:thinking', { node: makeNode('agent1'), thinking: 'deep thoughts' });

      const lines = stdoutLines();
      expect(lines[0]).toContain('thinking');
      expect(lines[0]).toContain('deep thoughts');
    });
  });

  // --- JSON mode ---

  describe('json mode', () => {
    it('outputs NDJSON for node:enter', () => {
      createFormatter(events, { json: true });
      events.emit('node:enter', { node: makeNode('greet'), context: makeContext() });

      const lines = stdoutLines();
      const parsed = JSON.parse(lines[0]);
      expect(parsed.event).toBe('node:enter');
      expect(parsed.node).toBe('greet');
      expect(parsed.ts).toBeDefined();
    });

    it('outputs NDJSON for node:exit with rounded duration', () => {
      createFormatter(events, { json: true });
      const node = makeNode('greet');
      events.emit('node:exit', { node, status: NodeStatus.SUCCESS, context: makeContext(), durationMs: 123.789 });

      const parsed = JSON.parse(stdoutLines()[0]);
      expect(parsed.durationMs).toBe(124);
    });

    it('includes agent:thinking in JSON verbose mode', () => {
      createFormatter(events, { json: true, verbose: true });
      events.emit('agent:thinking', { node: makeNode('agent1'), thinking: 'hmm' });

      const parsed = JSON.parse(stdoutLines()[0]);
      expect(parsed.event).toBe('agent:thinking');
    });

    it('excludes agent:thinking in JSON non-verbose mode', () => {
      createFormatter(events, { json: true });
      events.emit('agent:thinking', { node: makeNode('agent1'), thinking: 'hmm' });

      expect(stdoutLines()).toHaveLength(0);
    });
  });

  // --- Quiet mode ---

  describe('quiet mode', () => {
    it('suppresses node events', () => {
      createFormatter(events, { quiet: true });
      events.emit('node:enter', { node: makeNode('greet'), context: makeContext() });

      expect(stdoutLines()).toHaveLength(0);
    });

    it('prints errors to stderr', () => {
      createFormatter(events, { quiet: true });
      events.emit('node:error', { node: makeNode('greet'), error: new Error('boom'), context: makeContext() });

      const errLines = stderrSpy.mock.calls.map(([line]) => String(line));
      expect(errLines[0]).toContain('boom');
    });

    it('prints final tree:tick status', () => {
      createFormatter(events, { quiet: true });
      events.emit('tree:tick', { tree: 'my-tree', status: NodeStatus.SUCCESS, durationMs: 100 });

      const lines = stdoutLines();
      expect(lines[0]).toContain('my-tree');
      expect(lines[0]).toContain('SUCCESS');
    });
  });

  // --- Usage tracking ---

  function makeUsage(overrides: Partial<ModelUsage> = {}): ModelUsage {
    return {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.005,
      contextWindow: 200000,
      maxOutputTokens: 8192,
      ...overrides,
    };
  }

  describe('usage tracking (text mode)', () => {
    it('prints usage summary on terminal success tick', () => {
      createFormatter(events);
      events.emit('agent:response', {
        node: makeNode('agent1'),
        result: 'ok',
        cost: 0.005,
        modelUsage: { 'claude-sonnet-4-5-20250514': makeUsage() },
      });
      events.emit('tree:tick', { tree: 'my-tree', status: NodeStatus.SUCCESS, durationMs: 100 });

      const output = stdoutLines().join('');
      expect(output).toContain('Usage:');
      expect(output).toContain('claude-sonnet-4-5-20250514');
      expect(output).toContain('Input:');
      expect(output).toContain('Output:');
      expect(output).toContain('$0.0050');
      expect(output).toContain('Total:');
    });

    it('prints usage summary on terminal failure tick', () => {
      createFormatter(events);
      events.emit('agent:response', {
        node: makeNode('agent1'),
        result: 'ok',
        modelUsage: { 'claude-sonnet-4-5-20250514': makeUsage() },
      });
      events.emit('tree:tick', { tree: 'my-tree', status: NodeStatus.FAILURE, durationMs: 100 });

      const output = stdoutLines().join('');
      expect(output).toContain('Usage:');
    });

    it('does not print usage on RUNNING tick', () => {
      createFormatter(events);
      events.emit('agent:response', {
        node: makeNode('agent1'),
        result: 'ok',
        modelUsage: { 'claude-sonnet-4-5-20250514': makeUsage() },
      });
      events.emit('tree:tick', { tree: 'my-tree', status: NodeStatus.RUNNING, durationMs: 100 });

      const output = stdoutLines().join('');
      expect(output).not.toContain('Usage:');
    });

    it('accumulates usage across multiple responses from the same model', () => {
      createFormatter(events);
      const usage = makeUsage({ inputTokens: 100, outputTokens: 50, costUSD: 0.005 });
      events.emit('agent:response', {
        node: makeNode('agent1'),
        result: 'ok',
        modelUsage: { 'claude-sonnet-4-5-20250514': usage },
      });
      events.emit('agent:response', {
        node: makeNode('agent2'),
        result: 'ok',
        modelUsage: { 'claude-sonnet-4-5-20250514': makeUsage({ inputTokens: 200, outputTokens: 100, costUSD: 0.01 }) },
      });
      events.emit('tree:tick', { tree: 'my-tree', status: NodeStatus.SUCCESS, durationMs: 100 });

      const output = stdoutLines().join('');
      expect(output).toContain('$0.0150'); // 0.005 + 0.01
    });

    it('shows per-model breakdown for multiple models', () => {
      createFormatter(events);
      events.emit('agent:response', {
        node: makeNode('agent1'),
        result: 'ok',
        modelUsage: {
          'claude-sonnet-4-5-20250514': makeUsage({ costUSD: 0.005 }),
          'claude-haiku-4-5-20251001': makeUsage({ costUSD: 0.001 }),
        },
      });
      events.emit('tree:tick', { tree: 'my-tree', status: NodeStatus.SUCCESS, durationMs: 100 });

      const output = stdoutLines().join('');
      expect(output).toContain('claude-sonnet-4-5-20250514');
      expect(output).toContain('claude-haiku-4-5-20251001');
      expect(output).toContain('$0.0060'); // total
    });

    it('displays cache info when present', () => {
      createFormatter(events);
      events.emit('agent:response', {
        node: makeNode('agent1'),
        result: 'ok',
        modelUsage: {
          'claude-sonnet-4-5-20250514': makeUsage({ cacheReadInputTokens: 500, cacheCreationInputTokens: 200 }),
        },
      });
      events.emit('tree:tick', { tree: 'my-tree', status: NodeStatus.SUCCESS, durationMs: 100 });

      const output = stdoutLines().join('');
      expect(output).toContain('cache read:');
      expect(output).toContain('cache write:');
    });

    it('omits cache info when zero', () => {
      createFormatter(events);
      events.emit('agent:response', {
        node: makeNode('agent1'),
        result: 'ok',
        modelUsage: { 'claude-sonnet-4-5-20250514': makeUsage() },
      });
      events.emit('tree:tick', { tree: 'my-tree', status: NodeStatus.SUCCESS, durationMs: 100 });

      const output = stdoutLines().join('');
      expect(output).not.toContain('cache read:');
      expect(output).not.toContain('cache write:');
    });

    it('displays web searches when present', () => {
      createFormatter(events);
      events.emit('agent:response', {
        node: makeNode('agent1'),
        result: 'ok',
        modelUsage: { 'claude-sonnet-4-5-20250514': makeUsage({ webSearchRequests: 3 }) },
      });
      events.emit('tree:tick', { tree: 'my-tree', status: NodeStatus.SUCCESS, durationMs: 100 });

      const output = stdoutLines().join('');
      expect(output).toContain('Web searches:');
    });

    it('does not print usage when no agent responses occurred', () => {
      createFormatter(events);
      events.emit('tree:tick', { tree: 'my-tree', status: NodeStatus.SUCCESS, durationMs: 100 });

      const output = stdoutLines().join('');
      expect(output).not.toContain('Usage:');
    });

    it('accumulates usage from agent:error events', () => {
      createFormatter(events);
      events.emit('agent:error', {
        node: makeNode('agent1'),
        subtype: 'max_turns',
        modelUsage: { 'claude-sonnet-4-5-20250514': makeUsage({ costUSD: 0.01 }) },
      });
      events.emit('tree:tick', { tree: 'my-tree', status: NodeStatus.FAILURE, durationMs: 100 });

      const output = stdoutLines().join('');
      expect(output).toContain('Usage:');
      expect(output).toContain('$0.0100');
    });
  });

  describe('usage tracking (JSON mode)', () => {
    it('includes modelUsage in agent:response NDJSON', () => {
      createFormatter(events, { json: true });
      const mu = { 'claude-sonnet-4-5-20250514': makeUsage() };
      events.emit('agent:response', { node: makeNode('agent1'), result: 'ok', cost: 0.005, modelUsage: mu });

      const parsed = JSON.parse(stdoutLines()[0]);
      expect(parsed.modelUsage).toEqual(mu);
    });

    it('includes modelUsage in agent:error NDJSON', () => {
      createFormatter(events, { json: true });
      const mu = { 'claude-sonnet-4-5-20250514': makeUsage() };
      events.emit('agent:error', { node: makeNode('agent1'), subtype: 'max_turns', cost: 0.005, modelUsage: mu });

      const parsed = JSON.parse(stdoutLines()[0]);
      expect(parsed.modelUsage).toEqual(mu);
    });
  });

  describe('usage tracking (quiet mode)', () => {
    it('does not print usage summary', () => {
      createFormatter(events, { quiet: true });
      events.emit('agent:response', {
        node: makeNode('agent1'),
        result: 'ok',
        modelUsage: { 'claude-sonnet-4-5-20250514': makeUsage() },
      });
      events.emit('tree:tick', { tree: 'my-tree', status: NodeStatus.SUCCESS, durationMs: 100 });

      const output = stdoutLines().join('');
      expect(output).not.toContain('Usage:');
    });
  });

  // --- Cleanup ---

  it('cleanup removes listeners', () => {
    const stop = createFormatter(events);
    stop();

    events.emit('node:enter', { node: makeNode('greet'), context: makeContext() });
    expect(stdoutLines()).toHaveLength(0);
  });
});
