import { describe, it, expect, vi } from 'vitest';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';
import { buildStrategyPrompt, wrapElicitation } from './sdk-helpers.js';
import { TestAgent } from './test-agent.js';

function mockNode(name: string): BTreeNode {
  return {
    id: name, name,
    tick: async () => NodeStatus.SUCCESS,
    reset: () => {}, abort: () => {},
  };
}

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

describe('buildStrategyPrompt', () => {
  it('includes base prompt, children, and blackboard state', () => {
    const ctx = createContext();
    ctx.blackboard.set('key', 'value');

    const result = buildStrategyPrompt(
      { prompt: 'Pick the best order', agent: new TestAgent({ name: 'test' }) },
      [mockNode('a'), mockNode('b')],
      ctx,
    );

    expect(result).toContain('Pick the best order');
    expect(result).toContain('"name": "a"');
    expect(result).toContain('"name": "b"');
    expect(result).toContain('"key": "value"');
  });

  it('uses childDescriptions when provided', () => {
    const result = buildStrategyPrompt(
      {
        prompt: 'Order',
        childDescriptions: { a: 'First option', b: 'Second option' },
        agent: new TestAgent({ name: 'test' }),
      },
      [mockNode('a'), mockNode('b')],
      createContext(),
    );

    expect(result).toContain('"description": "First option"');
    expect(result).toContain('"description": "Second option"');
  });

  it('supports dynamic prompt function', () => {
    const ctx = createContext();
    ctx.blackboard.set('mode', 'fast');

    const result = buildStrategyPrompt(
      {
        prompt: (children, c) => `Run ${children.length} steps in ${c.blackboard.get('mode')} mode`,
        agent: new TestAgent({ name: 'test' }),
      },
      [mockNode('a'), mockNode('b')],
      ctx,
    );

    expect(result).toContain('Run 2 steps in fast mode');
  });
});

describe('wrapElicitation', () => {
  it('delegates to the provided handler', async () => {
    const handler = async () => ({ action: 'accept' as const, content: { token: 'abc' } });
    const node = mockNode('test');
    const events = new EventEmitter<TreeEvents>();
    const wrapped = wrapElicitation(handler, node, events);

    const result = await wrapped({} as any, { signal: new AbortController().signal });
    expect(result).toEqual({ action: 'accept', content: { token: 'abc' } });
  });

  it('declines and emits event when no handler is provided', async () => {
    const node = mockNode('test');
    const events = new EventEmitter<TreeEvents>();
    const spy = (events as any)._listeners?.['agent:elicitation_declined'] ?? [];
    const declinedSpy = vi.fn();
    events.on('agent:elicitation_declined', declinedSpy);

    const wrapped = wrapElicitation(undefined, node, events);
    const result = await wrapped({ serverName: 'test' } as any, { signal: new AbortController().signal });

    expect(result).toEqual({ action: 'decline' });
    expect(declinedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ node, request: { serverName: 'test' } }),
    );
  });
});
