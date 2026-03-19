import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';

// We'll mock the SDK's query function
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => handler),
}));

import { AgentNode } from './agent.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

const mockQuery = vi.mocked(query);

const flush = () => new Promise((r) => setTimeout(r, 0));

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

async function* mockMessages(messages: unknown[]) {
  for (const msg of messages) {
    yield msg;
  }
}

describe('AgentNode - structured output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns SUCCESS on successful structured output', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', structured_output: { answer: 'yes' }, total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({
      name: 'classify',
      prompt: 'Classify this input',
      options: {
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { answer: { type: 'string' } } },
        },
      },
    });

    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('writes structured output to blackboard', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', structured_output: { answer: 'yes' }, total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({
      name: 'classify',
      prompt: 'Classify this input',
      options: {
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { answer: { type: 'string' } } },
        },
      },
    });

    const ctx = createContext();
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);
    expect(ctx.blackboard.get('classify:output')).toEqual({ answer: 'yes' });
  });

  it('uses mapResult to determine status', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', structured_output: { confidence: 0.3 }, total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({
      name: 'classify',
      prompt: 'Classify',
      options: {
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { confidence: { type: 'number' } } },
        },
      },
      mapResult: (output: unknown) => {
        const data = output as { confidence: number };
        return data.confidence > 0.5 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
      },
    });

    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
  });

  it('returns FAILURE on SDK error', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'error_during_execution' },
    ]) as any);

    const node = new AgentNode({
      name: 'classify',
      prompt: 'Classify',
    });

    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
  });

  it('supports dynamic prompts from context', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', structured_output: {}, total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({
      name: 'dynamic',
      prompt: (ctx) => `Analyze: ${ctx.blackboard.get('input')}`,
    });

    const ctx = createContext();
    ctx.blackboard.set('input', 'test data');
    await node.tick(ctx); // starts inflight
    await flush();
    await node.tick(ctx); // completes

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Analyze: test data',
      }),
    );
  });
});

describe('AgentNode - unstructured output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns SUCCESS on successful execution', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Working...' }] } },
      { type: 'result', subtype: 'success', result: 'Fixed the bug', total_cost_usd: 0.05 },
    ]) as any);

    const node = new AgentNode({
      name: 'fixer',
      prompt: 'Fix the bug',
      options: { allowedTools: ['Read', 'Edit'] },
    });

    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('returns FAILURE on max_turns error', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'error_max_turns' },
    ]) as any);

    const node = new AgentNode({
      name: 'fixer',
      prompt: 'Fix the bug',
      options: { maxTurns: 5 },
    });

    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
  });

  it('writes result text to blackboard', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'All tests pass', total_cost_usd: 0.02 },
    ]) as any);

    const node = new AgentNode({
      name: 'runner',
      prompt: 'Run tests',
    });

    const ctx = createContext();
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);
    expect(ctx.blackboard.get('runner:output')).toBe('All tests pass');
  });

  it('writes result to namespaced key when blackboardNamespace is set', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'namespaced result', total_cost_usd: 0.02 },
    ]) as any);

    const node = new AgentNode({
      name: 'runner',
      prompt: 'Run tests',
      blackboardNamespace: 'integration',
    });

    const ctx = createContext();
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);
    expect(ctx.blackboard.get('integration:runner:output')).toBe('namespaced result');
    expect(ctx.blackboard.get('runner:output')).toBeUndefined();
  });

  it('emits agent:response event', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.03 },
    ]) as any);

    const node = new AgentNode({
      name: 'worker',
      prompt: 'Do work',
    });

    const ctx = createContext();
    const responseSpy = vi.fn();
    ctx.events.on('agent:response', responseSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(responseSpy).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'done', cost: 0.03 }),
    );
  });

  it('emits agent:tool_use events for tool calls', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'test.ts' } },
          ],
        },
      },
      { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({
      name: 'reader',
      prompt: 'Read files',
    });

    const ctx = createContext();
    const toolSpy = vi.fn();
    ctx.events.on('agent:tool_use', toolSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(toolSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'Read', input: { file_path: 'test.ts' } }),
    );
  });
});

describe('AgentNode - abort support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes an AbortController to the SDK options', async () => {
    let capturedAbortController: AbortController | undefined;

    // Mock query to capture the options and simulate a long-running call
    mockQuery.mockImplementation(({ options }: any) => {
      capturedAbortController = options.abortController;
      return mockMessages([
        { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 },
      ]) as any;
    });

    const node = new AgentNode({ name: 'abortable', prompt: 'Do work' });
    const ctx = createContext();
    await node.tick(ctx); // starts inflight
    await flush();
    await node.tick(ctx); // completes

    expect(capturedAbortController).toBeInstanceOf(AbortController);
    expect(capturedAbortController!.signal.aborted).toBe(false);

    // After execute completes, activeAbortController is cleared,
    // so abort() is a no-op (does not throw)
    node.abort();
  });

  it('abort() signals the AbortController during an in-flight call', async () => {
    let capturedAbortController: AbortController | undefined;
    let resolveMessage!: () => void;

    // Mock query that yields one message then waits — giving us time to call abort()
    mockQuery.mockImplementation(({ options }: any) => {
      capturedAbortController = options.abortController;
      return (async function* () {
        // Wait for the test to call abort() before yielding the result
        await new Promise<void>((resolve) => { resolveMessage = resolve; });
        yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
      })() as any;
    });

    const node = new AgentNode({ name: 'inflight', prompt: 'Do work' });
    const ctx = createContext();
    const tickPromise = node.tick(ctx);

    // The SDK call is in-flight — abort should signal the controller
    node.abort();
    expect(capturedAbortController!.signal.aborted).toBe(true);

    // Let the mock finish so the tick completes
    resolveMessage();
    await tickPromise;
  });

  it('creates a fresh AbortController per execute() call', async () => {
    const controllers: AbortController[] = [];

    mockQuery.mockImplementation(({ options }: any) => {
      controllers.push(options.abortController);
      return mockMessages([
        { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 },
      ]) as any;
    });

    const node = new AgentNode({ name: 'fresh-ac', prompt: 'Do work' });
    const ctx = createContext();

    await node.tick(ctx); // starts first inflight
    await flush();
    await node.tick(ctx); // completes first, clears inflight
    await node.tick(ctx); // starts second inflight
    await flush();
    await node.tick(ctx); // completes second

    expect(controllers).toHaveLength(2);
    expect(controllers[0]).not.toBe(controllers[1]);
  });

  it('aborts the SDK call when context.signal is aborted', async () => {
    let capturedAbortController: AbortController | undefined;
    let resolveMessage!: () => void;

    mockQuery.mockImplementation(({ options }: any) => {
      capturedAbortController = options.abortController;
      return (async function* () {
        await new Promise<void>((resolve) => { resolveMessage = resolve; });
        yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
      })() as any;
    });

    // Create a context with an abort signal (as BehaviorTree does)
    const treeAbortController = new AbortController();
    const ctx = createContext();
    ctx.signal = treeAbortController.signal;

    const node = new AgentNode({ name: 'signal-abort', prompt: 'Do work' });
    const tickPromise = node.tick(ctx);

    // Abort via the context signal (simulating BehaviorTree.abort())
    // without calling node.abort() directly
    treeAbortController.abort();
    expect(capturedAbortController!.signal.aborted).toBe(true);

    resolveMessage();
    await tickPromise;
  });
});

describe('AgentNode - observability events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits agent:thinking for thinking blocks', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me reason about this...' },
            { type: 'text', text: 'Here is my answer' },
          ],
        },
      },
      { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({ name: 'thinker', prompt: 'Think' });
    const ctx = createContext();
    const thinkingSpy = vi.fn();
    ctx.events.on('agent:thinking', thinkingSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(thinkingSpy).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: 'Let me reason about this...' }),
    );
  });

  it('emits agent:text for text blocks', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Working on it...' }] },
      },
      { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({ name: 'worker', prompt: 'Work' });
    const ctx = createContext();
    const textSpy = vi.fn();
    ctx.events.on('agent:text', textSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(textSpy).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Working on it...' }),
    );
  });

  it('emits agent:tool_use for tool calls', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'mcp__blackboard__get', input: { key: 'data' } },
          ],
        },
      },
      { type: 'result', subtype: 'success', structured_output: { answer: 'yes' }, total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({
      name: 'structured-tools',
      prompt: 'Classify',
      options: {
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { answer: { type: 'string' } } },
        },
      },
    });

    const ctx = createContext();
    const toolSpy = vi.fn();
    ctx.events.on('agent:tool_use', toolSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(toolSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'mcp__blackboard__get', input: { key: 'data' } }),
    );
  });

  it('emits agent:error on SDK error result', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'error_max_turns',
        errors: ['Exceeded maximum turns'],
        total_cost_usd: 0.05,
      },
    ]) as any);

    const node = new AgentNode({ name: 'errorer', prompt: 'Do stuff' });
    const ctx = createContext();
    const errorSpy = vi.fn();
    ctx.events.on('agent:error', errorSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        subtype: 'error_max_turns',
        errors: ['Exceeded maximum turns'],
        cost: 0.05,
      }),
    );
  });

  it('emits agent:error on execution failure', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'error_during_execution', errors: ['Something broke'] },
    ]) as any);

    const node = new AgentNode({ name: 'broken', prompt: 'Classify' });
    const ctx = createContext();
    const errorSpy = vi.fn();
    ctx.events.on('agent:error', errorSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ subtype: 'error_during_execution', errors: ['Something broke'] }),
    );
  });

  it('emits agent:stream for streaming delta events', async () => {
    const streamEvent = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } };
    mockQuery.mockReturnValue(mockMessages([
      { type: 'stream_event', event: streamEvent },
      { type: 'result', subtype: 'success', result: 'Hello', total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({ name: 'streamer', prompt: 'Say hello' });
    const ctx = createContext();
    const streamSpy = vi.fn();
    ctx.events.on('agent:stream', streamSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(streamSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: streamEvent }),
    );
  });

  it('emits agent:message for every SDK message', async () => {
    const messages = [
      { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-4-6', tools: [], mcp_servers: [] },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } },
      { type: 'result', subtype: 'success', result: 'Hi', total_cost_usd: 0.01 },
    ];
    mockQuery.mockReturnValue(mockMessages(messages) as any);

    const node = new AgentNode({ name: 'all-msgs', prompt: 'Hi' });
    const ctx = createContext();
    const msgSpy = vi.fn();
    ctx.events.on('agent:message', msgSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(msgSpy).toHaveBeenCalledTimes(3);
    expect(msgSpy.mock.calls[0][0].message).toEqual(messages[0]);
    expect(msgSpy.mock.calls[1][0].message).toEqual(messages[1]);
    expect(msgSpy.mock.calls[2][0].message).toEqual(messages[2]);
  });

  it('emits agent:tool_progress for tool progress updates', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'tool_progress', tool_use_id: 'tu-1', tool_name: 'Bash', elapsed_time_seconds: 5.2 },
      { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({ name: 'progressor', prompt: 'Run' });
    const ctx = createContext();
    const progressSpy = vi.fn();
    ctx.events.on('agent:tool_progress', progressSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(progressSpy).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: 'tu-1', toolName: 'Bash', elapsedSeconds: 5.2 }),
    );
  });

  it('emits agent:init for session init messages', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-abc',
        model: 'claude-opus-4-6',
        tools: ['Read', 'Edit'],
        mcp_servers: [{ name: 'blackboard' }],
      },
      { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({ name: 'initer', prompt: 'Init' });
    const ctx = createContext();
    const initSpy = vi.fn();
    ctx.events.on('agent:init', initSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(initSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-abc',
        model: 'claude-opus-4-6',
        tools: ['Read', 'Edit'],
        mcpServers: [{ name: 'blackboard' }],
      }),
    );
  });

  it('emits agent:status for status change messages', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'system', subtype: 'status', status: 'thinking' },
      { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({ name: 'statuser', prompt: 'Think' });
    const ctx = createContext();
    const statusSpy = vi.fn();
    ctx.events.on('agent:status', statusSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(statusSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'thinking' }),
    );
  });

  it('emits agent:rate_limit for rate limit events', async () => {
    const rateLimitInfo = { status: 'warning', resetsAt: '2026-03-09T12:00:00Z', rateLimitType: 'tokens' };
    mockQuery.mockReturnValue(mockMessages([
      { type: 'rate_limit_event', rate_limit_info: rateLimitInfo },
      { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({ name: 'limited', prompt: 'Go' });
    const ctx = createContext();
    const rateSpy = vi.fn();
    ctx.events.on('agent:rate_limit', rateSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(rateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ info: rateLimitInfo }),
    );
  });
});

describe('AgentNode - onElicitation wrapping', () => {
  const testRequest = {
    serverName: 'test-server',
    message: 'Please provide credentials',
    mode: 'form' as const,
    requestedSchema: { type: 'object', properties: { api_key: { type: 'string' } } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to context.onElicitation when no node-level handler is set', async () => {
    const contextHandler = vi.fn().mockResolvedValue({ action: 'accept', content: { api_key: 'sk-123' } });

    mockQuery.mockImplementation(async function* (args: any) {
      const handler = args.options.onElicitation;
      if (handler) {
        await handler(testRequest, { signal: new AbortController().signal });
      }
      yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
    } as any);

    const node = new AgentNode({ name: 'test', prompt: 'test' });
    const context = createContext();
    context.onElicitation = contextHandler;

    await node.tick(context);
    await flush();
    await node.tick(context);

    expect(contextHandler).toHaveBeenCalledWith(testRequest, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('prefers node-level options.onElicitation over context.onElicitation', async () => {
    const nodeHandler = vi.fn().mockResolvedValue({ action: 'accept' });
    const contextHandler = vi.fn().mockResolvedValue({ action: 'accept' });

    mockQuery.mockImplementation(async function* (args: any) {
      await args.options.onElicitation(testRequest, { signal: new AbortController().signal });
      yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
    } as any);

    const node = new AgentNode({ name: 'test', prompt: 'test', options: { onElicitation: nodeHandler } });
    const context = createContext();
    context.onElicitation = contextHandler;

    await node.tick(context);
    await flush();
    await node.tick(context);

    expect(nodeHandler).toHaveBeenCalled();
    expect(contextHandler).not.toHaveBeenCalled();
  });

  it('emits agent:elicitation_declined when no handler exists', async () => {
    let capturedResult: any;
    mockQuery.mockImplementation(async function* (args: any) {
      capturedResult = await args.options.onElicitation(testRequest, { signal: new AbortController().signal });
      yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
    } as any);

    const node = new AgentNode({ name: 'test', prompt: 'test' });
    const context = createContext();
    const declineSpy = vi.fn();
    context.events.on('agent:elicitation_declined', declineSpy);

    await node.tick(context);
    await flush();
    await node.tick(context);

    expect(declineSpy).toHaveBeenCalledWith({
      node,
      request: testRequest,
    });
    expect(capturedResult).toEqual({ action: 'decline' });
  });

  it('always provides onElicitation to the SDK options', async () => {
    let capturedOptions: any;
    mockQuery.mockImplementation(async function* (args: any) {
      capturedOptions = args.options;
      yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
    } as any);

    const node = new AgentNode({ name: 'test', prompt: 'test' });
    const ctx = createContext();
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(capturedOptions.onElicitation).toBeTypeOf('function');
  });
});

describe('AgentNode - inflight state management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns RUNNING on first tick while SDK call is in progress', async () => {
    let resolveMessage!: () => void;

    mockQuery.mockImplementation((() => {
      return (async function* () {
        await new Promise<void>((resolve) => { resolveMessage = resolve; });
        yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
      })();
    }) as any);

    const node = new AgentNode({ name: 'inflight-test', prompt: 'Do work' });
    const ctx = createContext();

    // First tick should return RUNNING immediately
    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);

    // Clean up: let the background work finish
    resolveMessage();
    // Wait for the promise to settle
    await new Promise((r) => setTimeout(r, 0));
  });

  it('returns SUCCESS on subsequent tick after SDK call completes', async () => {
    let resolveMessage!: () => void;

    mockQuery.mockImplementation((() => {
      return (async function* () {
        await new Promise<void>((resolve) => { resolveMessage = resolve; });
        yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
      })();
    }) as any);

    const node = new AgentNode({ name: 'inflight-test', prompt: 'Do work' });
    const ctx = createContext();

    // First tick: starts work, returns RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);

    // Let the SDK call complete
    resolveMessage();
    await new Promise((r) => setTimeout(r, 0));

    // Second tick: polls and returns the final status
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('abort() clears inflight state', async () => {
    let resolveMessage!: () => void;

    mockQuery.mockImplementation((() => {
      return (async function* () {
        await new Promise<void>((resolve) => { resolveMessage = resolve; });
        yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
      })();
    }) as any);

    const node = new AgentNode({ name: 'abort-inflight', prompt: 'Do work' });
    const ctx = createContext();

    // First tick starts the work
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);

    // Abort clears inflight state
    node.abort();

    // Next tick should start fresh work (new inflight), not poll the old one
    // We need a new mock for the second invocation
    mockQuery.mockImplementation((() => {
      return (async function* () {
        yield { type: 'result', subtype: 'success', result: 'done2', total_cost_usd: 0.01 };
      })();
    }) as any);

    const status = await node.tick(ctx);
    // It starts a new inflight, so returns RUNNING again
    expect(status).toBe(NodeStatus.RUNNING);

    // Clean up
    resolveMessage();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('reset() clears inflight state', async () => {
    let resolveMessage!: () => void;

    mockQuery.mockImplementation((() => {
      return (async function* () {
        await new Promise<void>((resolve) => { resolveMessage = resolve; });
        yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
      })();
    }) as any);

    const node = new AgentNode({ name: 'reset-inflight', prompt: 'Do work' });
    const ctx = createContext();

    // First tick starts the work
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);

    // Reset clears inflight state
    node.reset();

    // Next tick should start fresh work
    mockQuery.mockImplementation((() => {
      return (async function* () {
        yield { type: 'result', subtype: 'success', result: 'done2', total_cost_usd: 0.01 };
      })();
    }) as any);

    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);

    // Clean up
    resolveMessage();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('multiple poll ticks do not re-invoke the SDK', async () => {
    let resolveMessage!: () => void;

    mockQuery.mockImplementation((() => {
      return (async function* () {
        await new Promise<void>((resolve) => { resolveMessage = resolve; });
        yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
      })();
    }) as any);

    const node = new AgentNode({ name: 'no-reinvoke', prompt: 'Do work' });
    const ctx = createContext();

    // First tick starts the work
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    // Second tick polls (still running)
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    // Third tick polls (still running)
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);

    // SDK should only have been called once
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // Let it complete and collect result
    resolveMessage();
    await new Promise((r) => setTimeout(r, 0));
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);

    // Still only one SDK call
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('cached results still return immediately without inflight', async () => {
    mockQuery.mockImplementation((() => {
      return (async function* () {
        yield { type: 'result', subtype: 'success', result: 'cached-result', total_cost_usd: 0.01 };
      })();
    }) as any);

    const node = new AgentNode({ name: 'cached-agent', prompt: 'Do work', cache: true });
    const ctx = createContext();

    // First tick: starts inflight, returns RUNNING
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);

    // Let the SDK call complete
    await new Promise((r) => setTimeout(r, 0));

    // Second tick: polls inflight, gets SUCCESS, caches it
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);

    // Third tick: returns cached result immediately (no new SDK call)
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);

    // SDK was only called once (for the initial inflight)
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('AgentNode - serialize/restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serialize() returns { lastStatus } after a terminal tick', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({ name: 'ser-success', prompt: 'Do work' });
    const ctx = createContext();

    // Tick to start, then flush + tick to complete
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(node.serialize()).toEqual({ lastStatus: NodeStatus.SUCCESS });
  });

  it('serialize() returns {} when no terminal status has been recorded', () => {
    const node = new AgentNode({ name: 'ser-empty', prompt: 'Do work' });
    expect(node.serialize()).toEqual({});
  });

  it('restore({ lastStatus: failure }) sets internal _lastTerminalStatus', () => {
    const node = new AgentNode({ name: 'restore-test', prompt: 'Do work' });
    node.restore({ lastStatus: NodeStatus.FAILURE }, new Map());
    expect(node.serialize()).toEqual({ lastStatus: NodeStatus.FAILURE });
  });
});

describe('AgentNode - $schema stripping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strips $schema property from outputFormat.schema before SDK call', async () => {
    let capturedOptions: any;

    mockQuery.mockImplementation(async function* (args: any) {
      capturedOptions = args.options;
      yield { type: 'result', subtype: 'success', structured_output: { answer: 'yes' }, total_cost_usd: 0.01 };
    } as any);

    const node = new AgentNode({
      name: 'schema-strip',
      prompt: 'Classify',
      options: {
        outputFormat: {
          type: 'json_schema',
          schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: { answer: { type: 'string' } },
          },
        },
      },
    });

    const ctx = createContext();
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    // The $schema property should have been stripped
    expect(capturedOptions.outputFormat.schema).toEqual({
      type: 'object',
      properties: { answer: { type: 'string' } },
    });
    expect(capturedOptions.outputFormat.schema).not.toHaveProperty('$schema');
  });
});

describe('AgentNode - structured output fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to JSON-parsing msg.result when structured_output is undefined', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: undefined,
        result: '{"parsed":true}',
        total_cost_usd: 0.01,
      },
    ]) as any);

    const node = new AgentNode({
      name: 'fallback-json',
      prompt: 'Classify',
      options: {
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { parsed: { type: 'boolean' } } },
        },
      },
    });

    const ctx = createContext();
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(ctx.blackboard.get('fallback-json:output')).toEqual({ parsed: true });
  });

  it('falls back to raw string when msg.result is not valid JSON', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: undefined,
        result: 'not valid json',
        total_cost_usd: 0.01,
      },
    ]) as any);

    const node = new AgentNode({
      name: 'fallback-raw',
      prompt: 'Classify',
      options: {
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { answer: { type: 'string' } } },
        },
      },
    });

    const ctx = createContext();
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(ctx.blackboard.get('fallback-raw:output')).toBe('not valid json');
  });
});

describe('AgentNode - stream EOF', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns FAILURE when stream ends without a result message', async () => {
    mockQuery.mockReturnValue(mockMessages([]) as any);

    const node = new AgentNode({ name: 'eof-test', prompt: 'Do work' });
    const ctx = createContext();

    // First tick starts inflight
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    // Second tick polls the completed result — should be FAILURE
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
  });
});

describe('AgentNode - SDK abort rejection handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Reset the static flag so each test installs fresh
    (AgentNode as any).sdkAbortHandlerInstalled = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses matching SDK abort rejections arriving after 500ms', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', output: 'done', total_cost_usd: 0 },
    ]) as any);

    const node = new AgentNode({ name: 'abort-test', prompt: 'Do work' });
    const ctx = createContext();

    // Tick to start inflight, then abort to trigger handler installation
    await node.tick(ctx);
    node.abort();

    // Advance past the old 500ms cleanup window
    await vi.advanceTimersByTimeAsync(600);

    // Simulate a late SDK rejection — with the old implementation, the
    // handler would have been removed by now and this would be unhandled.
    const sdkError = new Error('Operation aborted');
    sdkError.stack = 'Error: Operation aborted\n    at x9.write (sdk.mjs)\n    at g9.handleControlRequest (sdk.mjs)';

    // Track whether 'rejectionHandled' fires — this proves our handler
    // retroactively caught the promise via promise.catch(() => {}).
    const rejectionHandled = vi.fn();
    process.once('rejectionHandled', rejectionHandled);

    const p = Promise.reject(sdkError);
    await vi.advanceTimersByTimeAsync(0);

    // The permanent handler should have called promise.catch(), which
    // triggers the 'rejectionHandled' event.
    expect(rejectionHandled).toHaveBeenCalled();

    p.catch(() => {}); // safety cleanup
  });

  it('does not suppress unrelated rejections', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', output: 'done', total_cost_usd: 0 },
    ]) as any);

    const node = new AgentNode({ name: 'unrelated-test', prompt: 'Do work' });
    const ctx = createContext();

    await node.tick(ctx);
    node.abort();

    // Emit a rejection that does NOT match the SDK pattern
    const unrelatedHandler = vi.fn();
    process.once('unhandledRejection', unrelatedHandler);

    const unrelatedErr = new Error('Something else broke');
    const p = Promise.reject(unrelatedErr);

    await vi.advanceTimersByTimeAsync(0);

    expect(unrelatedHandler).toHaveBeenCalledWith(unrelatedErr, p);

    // Clean up
    p.catch(() => {});
  });

  it('installs the handler only once across multiple aborts', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', output: 'done', total_cost_usd: 0 },
    ]) as any);

    const listenerCountBefore = process.listenerCount('unhandledRejection');

    const node = new AgentNode({ name: 'multi-abort', prompt: 'Do work' });
    const ctx = createContext();

    // Abort multiple times
    await node.tick(ctx);
    node.abort();

    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', output: 'done', total_cost_usd: 0 },
    ]) as any);
    await node.tick(ctx);
    node.abort();

    // Should only have added one listener
    const listenerCountAfter = process.listenerCount('unhandledRejection');
    expect(listenerCountAfter - listenerCountBefore).toBe(1);
  });
});
