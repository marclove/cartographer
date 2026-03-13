import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFormatter } from './formatter.js';
import { EventEmitter } from '../core/event-emitter.js';
import type { TreeEvents } from '../types.js';
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

  // --- Cleanup ---

  it('cleanup removes listeners', () => {
    const stop = createFormatter(events);
    stop();

    events.emit('node:enter', { node: makeNode('greet'), context: makeContext() });
    expect(stdoutLines()).toHaveLength(0);
  });
});
