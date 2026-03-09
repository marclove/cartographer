import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { MapBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => handler),
}));

import { AgentSelectionStrategy } from './agent-selection.js';
import { AgentExecutionStrategy } from './agent-execution.js';
import { AgentParallelStrategy } from './agent-parallel.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

const mockQuery = vi.mocked(query);

function createContext(): TreeContext {
  return {
    blackboard: new MapBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

function mockNode(name: string): BTreeNode {
  return {
    id: name, name,
    tick: async () => NodeStatus.SUCCESS,
    reset: () => {}, abort: () => {},
  };
}

async function* mockMessages(messages: unknown[]) {
  for (const msg of messages) {
    yield msg;
  }
}

describe('AgentSelectionStrategy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reorders children based on Claude response', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: { ordering: ['c', 'a', 'b'], reasoning: 'c is most relevant' },
        total_cost_usd: 0.01,
      },
    ]) as any);

    const strategy = new AgentSelectionStrategy({
      prompt: 'Pick the best order',
      childDescriptions: { a: 'first', b: 'second', c: 'third' },
    });

    const children = [mockNode('a'), mockNode('b'), mockNode('c')];
    const result = await strategy.order(children, createContext());
    expect(result.map((n) => n.name)).toEqual(['c', 'a', 'b']);
  });

  it('falls back to original order on SDK failure', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'error_during_execution' },
    ]) as any);

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick order' });
    const children = [mockNode('a'), mockNode('b')];
    const result = await strategy.order(children, createContext());
    expect(result.map((n) => n.name)).toEqual(['a', 'b']);
  });

  it('falls back to original order if Claude returns unknown names', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: { ordering: ['x', 'y', 'z'], reasoning: 'random' },
        total_cost_usd: 0.01,
      },
    ]) as any);

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick order' });
    const children = [mockNode('a'), mockNode('b')];
    const result = await strategy.order(children, createContext());
    expect(result.map((n) => n.name)).toEqual(['a', 'b']);
  });

  it('emits strategy:decision event', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: { ordering: ['a'], reasoning: 'only one' },
        total_cost_usd: 0.01,
      },
    ]) as any);

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick' });
    const ctx = createContext();
    const spy = vi.fn();
    ctx.events.on('strategy:decision', spy);
    await strategy.order([mockNode('a')], ctx);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'agent-selection' }),
    );
  });

  it('supports dynamic prompt function', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: { ordering: ['a'], reasoning: 'ok' },
        total_cost_usd: 0.01,
      },
    ]) as any);

    const strategy = new AgentSelectionStrategy({
      prompt: (children, ctx) => `Choose from ${children.length} options, state: ${ctx.blackboard.get('state')}`,
    });

    const ctx = createContext();
    ctx.blackboard.set('state', 'active');
    await strategy.order([mockNode('a')], ctx);
    expect(mockQuery).toHaveBeenCalled();
  });
});

describe('AgentExecutionStrategy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reorders children based on Claude response', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: { ordering: ['b', 'a'], reasoning: 'b first' },
        total_cost_usd: 0.01,
      },
    ]) as any);

    const strategy = new AgentExecutionStrategy({ prompt: 'Order steps' });
    const children = [mockNode('a'), mockNode('b')];
    const result = await strategy.order(children, createContext());
    expect(result.map((n) => n.name)).toEqual(['b', 'a']);
  });

  it('falls back to original order on failure', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'error_during_execution' },
    ]) as any);

    const strategy = new AgentExecutionStrategy({ prompt: 'Order' });
    const children = [mockNode('a'), mockNode('b')];
    const result = await strategy.order(children, createContext());
    expect(result.map((n) => n.name)).toEqual(['a', 'b']);
  });
});

describe('AgentParallelStrategy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns policy from Claude response', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: { policy: { successCount: 2 }, reasoning: 'need at least 2' },
        total_cost_usd: 0.01,
      },
    ]) as any);

    const strategy = new AgentParallelStrategy({ prompt: 'Set policy' });
    const children = [mockNode('a'), mockNode('b'), mockNode('c')];
    const result = await strategy.policy(children, createContext());
    expect(result).toEqual({ successCount: 2 });
  });

  it('falls back to require-all policy on failure', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'error_during_execution' },
    ]) as any);

    const strategy = new AgentParallelStrategy({ prompt: 'Set policy' });
    const children = [mockNode('a'), mockNode('b')];
    const result = await strategy.policy(children, createContext());
    expect(result).toEqual({ successCount: 2 });
  });
});
