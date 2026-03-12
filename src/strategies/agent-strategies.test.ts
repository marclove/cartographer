import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { MapBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';
import { emitMessageEvents } from '../agent/sdk-helpers.js';

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

  it('emits agent:prompt before the SDK call', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: { ordering: ['a'], reasoning: 'ok' },
        total_cost_usd: 0.01,
      },
    ]) as any);

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick' });
    const ctx = createContext();
    const spy = vi.fn();
    ctx.events.on('agent:prompt', spy);
    await strategy.order([mockNode('a')], ctx);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.any(String) }),
    );
    expect(spy.mock.calls[0][0].prompt).toContain('Pick');
  });

  it('emits agent:response on successful result', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: { ordering: ['a'], reasoning: 'ok' },
        total_cost_usd: 0.05,
      },
    ]) as any);

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick' });
    const ctx = createContext();
    const spy = vi.fn();
    ctx.events.on('agent:response', spy);
    await strategy.order([mockNode('a')], ctx);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        result: { ordering: ['a'], reasoning: 'ok' },
        cost: 0.05,
      }),
    );
  });

  it('emits agent:error on non-success result subtypes', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['something broke'],
        total_cost_usd: 0.02,
      },
    ]) as any);

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick' });
    const ctx = createContext();
    const spy = vi.fn();
    ctx.events.on('agent:error', spy);
    await strategy.order([mockNode('a')], ctx);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        subtype: 'error_during_execution',
        errors: ['something broke'],
        cost: 0.02,
      }),
    );
  });

  it('emits agent:thinking and agent:text for intermediate messages', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me consider...' },
            { type: 'text', text: 'I think option A' },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        structured_output: { ordering: ['a'], reasoning: 'ok' },
        total_cost_usd: 0.01,
      },
    ]) as any);

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick' });
    const ctx = createContext();
    const thinkingSpy = vi.fn();
    const textSpy = vi.fn();
    const messageSpy = vi.fn();
    ctx.events.on('agent:thinking', thinkingSpy);
    ctx.events.on('agent:text', textSpy);
    ctx.events.on('agent:message', messageSpy);
    await strategy.order([mockNode('a')], ctx);

    expect(thinkingSpy).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: 'Let me consider...' }),
    );
    expect(textSpy).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'I think option A' }),
    );
    // Two messages: assistant + result
    expect(messageSpy).toHaveBeenCalledTimes(2);
  });

  it('does not emit agent:response on fallback (null return)', async () => {
    mockQuery.mockImplementation(() => {
      throw new Error('SDK crash');
    });

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick' });
    const ctx = createContext();
    const responseSpy = vi.fn();
    const errorSpy = vi.fn();
    ctx.events.on('agent:response', responseSpy);
    ctx.events.on('agent:error', errorSpy);
    await strategy.order([mockNode('a')], ctx);

    expect(responseSpy).not.toHaveBeenCalled();
    // SDK exception means the callback never fires, so no agent:error either
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('passes context.signal through to the SDK', async () => {
    let capturedOptions: any;
    mockQuery.mockImplementation(({ options }: any) => {
      capturedOptions = options;
      return mockMessages([
        { type: 'result', subtype: 'success', structured_output: { ordering: ['a'], reasoning: 'ok' }, total_cost_usd: 0.01 },
      ]) as any;
    });

    const ac = new AbortController();
    const ctx = createContext();
    ctx.signal = ac.signal;

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick' });
    await strategy.order([mockNode('a')], ctx);

    expect(capturedOptions.abortController).toBeInstanceOf(AbortController);
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

  it('emits agent:prompt and agent:response events', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: { ordering: ['a'], reasoning: 'ok' },
        total_cost_usd: 0.03,
      },
    ]) as any);

    const strategy = new AgentExecutionStrategy({ prompt: 'Order' });
    const ctx = createContext();
    const promptSpy = vi.fn();
    const responseSpy = vi.fn();
    ctx.events.on('agent:prompt', promptSpy);
    ctx.events.on('agent:response', responseSpy);
    await strategy.order([mockNode('a')], ctx);

    expect(promptSpy).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.any(String) }),
    );
    expect(responseSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cost: 0.03 }),
    );
  });

  it('passes context.signal through to the SDK', async () => {
    let capturedOptions: any;
    mockQuery.mockImplementation(({ options }: any) => {
      capturedOptions = options;
      return mockMessages([
        { type: 'result', subtype: 'success', structured_output: { ordering: ['a'], reasoning: 'ok' }, total_cost_usd: 0.01 },
      ]) as any;
    });

    const ac = new AbortController();
    const ctx = createContext();
    ctx.signal = ac.signal;

    const strategy = new AgentExecutionStrategy({ prompt: 'Order' });
    await strategy.order([mockNode('a')], ctx);

    expect(capturedOptions.abortController).toBeInstanceOf(AbortController);
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

  it('emits agent:prompt and agent:response events', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: { policy: { successCount: 1 }, reasoning: 'ok' },
        total_cost_usd: 0.04,
      },
    ]) as any);

    const strategy = new AgentParallelStrategy({ prompt: 'Set policy' });
    const ctx = createContext();
    const promptSpy = vi.fn();
    const responseSpy = vi.fn();
    ctx.events.on('agent:prompt', promptSpy);
    ctx.events.on('agent:response', responseSpy);
    await strategy.policy([mockNode('a')], ctx);

    expect(promptSpy).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.any(String) }),
    );
    expect(responseSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cost: 0.04 }),
    );
  });

  it('emits agent:error on non-success result', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['timeout'],
        total_cost_usd: 0.01,
      },
    ]) as any);

    const strategy = new AgentParallelStrategy({ prompt: 'Set policy' });
    const ctx = createContext();
    const spy = vi.fn();
    ctx.events.on('agent:error', spy);
    await strategy.policy([mockNode('a')], ctx);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        subtype: 'error_during_execution',
        errors: ['timeout'],
      }),
    );
  });

  it('passes context.signal through to the SDK', async () => {
    let capturedOptions: any;
    mockQuery.mockImplementation(({ options }: any) => {
      capturedOptions = options;
      return mockMessages([
        { type: 'result', subtype: 'success', structured_output: { policy: { successCount: 1 }, reasoning: 'ok' }, total_cost_usd: 0.01 },
      ]) as any;
    });

    const ac = new AbortController();
    const ctx = createContext();
    ctx.signal = ac.signal;

    const strategy = new AgentParallelStrategy({ prompt: 'Set policy' });
    await strategy.policy([mockNode('a')], ctx);

    expect(capturedOptions.abortController).toBeInstanceOf(AbortController);
  });
});

describe('onElicitation wrapping', () => {
  beforeEach(() => vi.clearAllMocks());

  const testRequest = {
    serverName: 'test-mcp-server',
    message: 'Please authenticate',
    mode: 'form' as const,
    requestedSchema: { type: 'object', properties: { token: { type: 'string' } } },
  };

  function setupElicitationMock() {
    mockQuery.mockImplementation(async function* (args: any) {
      const handler = args.options.onElicitation;
      if (handler) {
        await handler(testRequest, { signal: new AbortController().signal });
      }
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: { ordering: ['a'], reasoning: 'ok' },
        total_cost_usd: 0.01,
      };
    } as any);
  }

  function setupElicitationMockParallel() {
    mockQuery.mockImplementation(async function* (args: any) {
      const handler = args.options.onElicitation;
      if (handler) {
        await handler(testRequest, { signal: new AbortController().signal });
      }
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: { policy: { successCount: 1 }, reasoning: 'ok' },
        total_cost_usd: 0.01,
      };
    } as any);
  }

  describe('AgentSelectionStrategy', () => {
    it('delegates to context.onElicitation', async () => {
      setupElicitationMock();
      const handler = vi.fn().mockResolvedValue({ action: 'accept', content: { token: 'abc' } });
      const ctx = createContext();
      ctx.onElicitation = handler;

      const strategy = new AgentSelectionStrategy({ prompt: 'Pick' });
      await strategy.order([mockNode('a')], ctx);

      expect(handler).toHaveBeenCalledWith(testRequest, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it('prefers config.options.onElicitation over context.onElicitation', async () => {
      setupElicitationMock();
      const contextHandler = vi.fn().mockResolvedValue({ action: 'accept' });
      const configHandler = vi.fn().mockResolvedValue({ action: 'accept' });
      const ctx = createContext();
      ctx.onElicitation = contextHandler;

      const strategy = new AgentSelectionStrategy({ prompt: 'Pick', options: { onElicitation: configHandler } });
      await strategy.order([mockNode('a')], ctx);

      expect(configHandler).toHaveBeenCalled();
      expect(contextHandler).not.toHaveBeenCalled();
    });

    it('emits agent:elicitation_declined when no handler exists', async () => {
      setupElicitationMock();
      const ctx = createContext();
      const spy = vi.fn();
      ctx.events.on('agent:elicitation_declined', spy);

      const strategy = new AgentSelectionStrategy({ prompt: 'Pick' });
      await strategy.order([mockNode('a')], ctx);

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ request: testRequest }));
    });

    it('always provides onElicitation to SDK', async () => {
      let capturedOptions: any;
      mockQuery.mockImplementation(async function* (args: any) {
        capturedOptions = args.options;
        yield { type: 'result', subtype: 'success', structured_output: { ordering: ['a'], reasoning: 'ok' }, total_cost_usd: 0.01 };
      } as any);

      const strategy = new AgentSelectionStrategy({ prompt: 'Pick' });
      await strategy.order([mockNode('a')], createContext());

      expect(typeof capturedOptions.onElicitation).toBe('function');
    });
  });

  describe('AgentExecutionStrategy', () => {
    it('delegates to context.onElicitation', async () => {
      setupElicitationMock();
      const handler = vi.fn().mockResolvedValue({ action: 'accept', content: { token: 'abc' } });
      const ctx = createContext();
      ctx.onElicitation = handler;

      const strategy = new AgentExecutionStrategy({ prompt: 'Order' });
      await strategy.order([mockNode('a')], ctx);

      expect(handler).toHaveBeenCalledWith(testRequest, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it('prefers config.options.onElicitation over context.onElicitation', async () => {
      setupElicitationMock();
      const contextHandler = vi.fn().mockResolvedValue({ action: 'accept' });
      const configHandler = vi.fn().mockResolvedValue({ action: 'accept' });
      const ctx = createContext();
      ctx.onElicitation = contextHandler;

      const strategy = new AgentExecutionStrategy({ prompt: 'Order', options: { onElicitation: configHandler } });
      await strategy.order([mockNode('a')], ctx);

      expect(configHandler).toHaveBeenCalled();
      expect(contextHandler).not.toHaveBeenCalled();
    });

    it('emits agent:elicitation_declined when no handler exists', async () => {
      setupElicitationMock();
      const ctx = createContext();
      const spy = vi.fn();
      ctx.events.on('agent:elicitation_declined', spy);

      const strategy = new AgentExecutionStrategy({ prompt: 'Order' });
      await strategy.order([mockNode('a')], ctx);

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ request: testRequest }));
    });

    it('always provides onElicitation to SDK', async () => {
      let capturedOptions: any;
      mockQuery.mockImplementation(async function* (args: any) {
        capturedOptions = args.options;
        yield { type: 'result', subtype: 'success', structured_output: { ordering: ['a'], reasoning: 'ok' }, total_cost_usd: 0.01 };
      } as any);

      const strategy = new AgentExecutionStrategy({ prompt: 'Order' });
      await strategy.order([mockNode('a')], createContext());

      expect(typeof capturedOptions.onElicitation).toBe('function');
    });
  });

  describe('AgentParallelStrategy', () => {
    it('delegates to context.onElicitation', async () => {
      setupElicitationMockParallel();
      const handler = vi.fn().mockResolvedValue({ action: 'accept', content: { token: 'abc' } });
      const ctx = createContext();
      ctx.onElicitation = handler;

      const strategy = new AgentParallelStrategy({ prompt: 'Set policy' });
      await strategy.policy([mockNode('a')], ctx);

      expect(handler).toHaveBeenCalledWith(testRequest, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it('prefers config.options.onElicitation over context.onElicitation', async () => {
      setupElicitationMockParallel();
      const contextHandler = vi.fn().mockResolvedValue({ action: 'accept' });
      const configHandler = vi.fn().mockResolvedValue({ action: 'accept' });
      const ctx = createContext();
      ctx.onElicitation = contextHandler;

      const strategy = new AgentParallelStrategy({ prompt: 'Set policy', options: { onElicitation: configHandler } });
      await strategy.policy([mockNode('a')], ctx);

      expect(configHandler).toHaveBeenCalled();
      expect(contextHandler).not.toHaveBeenCalled();
    });

    it('emits agent:elicitation_declined when no handler exists', async () => {
      setupElicitationMockParallel();
      const ctx = createContext();
      const spy = vi.fn();
      ctx.events.on('agent:elicitation_declined', spy);

      const strategy = new AgentParallelStrategy({ prompt: 'Set policy' });
      await strategy.policy([mockNode('a')], ctx);

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ request: testRequest }));
    });

    it('always provides onElicitation to SDK', async () => {
      let capturedOptions: any;
      mockQuery.mockImplementation(async function* (args: any) {
        capturedOptions = args.options;
        yield { type: 'result', subtype: 'success', structured_output: { policy: { successCount: 1 }, reasoning: 'ok' }, total_cost_usd: 0.01 };
      } as any);

      const strategy = new AgentParallelStrategy({ prompt: 'Set policy' });
      await strategy.policy([mockNode('a')], createContext());

      expect(typeof capturedOptions.onElicitation).toBe('function');
    });
  });
});

describe('emitMessageEvents', () => {
  it('emits agent:message for every message', () => {
    const events = new EventEmitter<TreeEvents>();
    const node = mockNode('test');
    const spy = vi.fn();
    events.on('agent:message', spy);

    const msg = { type: 'unknown', data: 'foo' };
    emitMessageEvents(msg, node, events);

    expect(spy).toHaveBeenCalledWith({ node, message: msg });
  });

  it('emits agent:thinking for thinking content blocks', () => {
    const events = new EventEmitter<TreeEvents>();
    const node = mockNode('test');
    const spy = vi.fn();
    events.on('agent:thinking', spy);

    emitMessageEvents(
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } },
      node,
      events,
    );

    expect(spy).toHaveBeenCalledWith({ node, thinking: 'hmm' });
  });

  it('emits agent:text for text content blocks', () => {
    const events = new EventEmitter<TreeEvents>();
    const node = mockNode('test');
    const spy = vi.fn();
    events.on('agent:text', spy);

    emitMessageEvents(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
      node,
      events,
    );

    expect(spy).toHaveBeenCalledWith({ node, text: 'hello' });
  });

  it('emits agent:tool_use for tool_use content blocks', () => {
    const events = new EventEmitter<TreeEvents>();
    const node = mockNode('test');
    const spy = vi.fn();
    events.on('agent:tool_use', spy);

    emitMessageEvents(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'search', input: { q: 'test' } }] } },
      node,
      events,
    );

    expect(spy).toHaveBeenCalledWith({ node, tool: 'search', input: { q: 'test' } });
  });

  it('emits agent:stream for stream_event messages', () => {
    const events = new EventEmitter<TreeEvents>();
    const node = mockNode('test');
    const spy = vi.fn();
    events.on('agent:stream', spy);

    emitMessageEvents({ type: 'stream_event', event: { delta: 'tok' } }, node, events);

    expect(spy).toHaveBeenCalledWith({ node, event: { delta: 'tok' } });
  });

  it('emits agent:init for system init messages', () => {
    const events = new EventEmitter<TreeEvents>();
    const node = mockNode('test');
    const spy = vi.fn();
    events.on('agent:init', spy);

    emitMessageEvents(
      { type: 'system', subtype: 'init', session_id: 's1', model: 'sonnet', tools: [], mcp_servers: [] },
      node,
      events,
    );

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ node, sessionId: 's1', model: 'sonnet' }),
    );
  });

  it('emits agent:status for system status messages', () => {
    const events = new EventEmitter<TreeEvents>();
    const node = mockNode('test');
    const spy = vi.fn();
    events.on('agent:status', spy);

    emitMessageEvents({ type: 'system', subtype: 'status', status: 'running' }, node, events);

    expect(spy).toHaveBeenCalledWith({ node, status: 'running' });
  });

  it('emits agent:rate_limit for rate_limit_event messages', () => {
    const events = new EventEmitter<TreeEvents>();
    const node = mockNode('test');
    const spy = vi.fn();
    events.on('agent:rate_limit', spy);

    emitMessageEvents(
      { type: 'rate_limit_event', rate_limit_info: { retry_after: 5 } },
      node,
      events,
    );

    expect(spy).toHaveBeenCalledWith({ node, info: { retry_after: 5 } });
  });

  it('emits agent:tool_progress for tool_progress messages', () => {
    const events = new EventEmitter<TreeEvents>();
    const node = mockNode('test');
    const spy = vi.fn();
    events.on('agent:tool_progress', spy);

    emitMessageEvents(
      { type: 'tool_progress', tool_use_id: 'tu1', tool_name: 'search', elapsed_time_seconds: 2.5 },
      node,
      events,
    );

    expect(spy).toHaveBeenCalledWith({ node, toolUseId: 'tu1', toolName: 'search', elapsedSeconds: 2.5 });
  });
});
