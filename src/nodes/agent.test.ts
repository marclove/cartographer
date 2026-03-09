import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { MapBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';
import { z } from 'zod/v4';

// We'll mock the SDK's query function
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => handler),
}));

import { AgentNode } from './agent.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

const mockQuery = vi.mocked(query);

function createContext(): TreeContext {
  return {
    blackboard: new MapBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

async function* mockMessages(messages: unknown[]) {
  for (const msg of messages) {
    yield msg;
  }
}

describe('AgentNode - structured mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns SUCCESS on successful structured output', async () => {
    const schema = z.object({ answer: z.string() });
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', structured_output: { answer: 'yes' }, total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({
      name: 'classify',
      mode: 'structured',
      prompt: 'Classify this input',
      outputSchema: schema,
    });

    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('writes structured output to blackboard', async () => {
    const schema = z.object({ answer: z.string() });
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', structured_output: { answer: 'yes' }, total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({
      name: 'classify',
      mode: 'structured',
      prompt: 'Classify this input',
      outputSchema: schema,
    });

    const ctx = createContext();
    await node.tick(ctx);
    expect(ctx.blackboard.get('classify:output')).toEqual({ answer: 'yes' });
  });

  it('uses mapResult to determine status', async () => {
    const schema = z.object({ confidence: z.number() });
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', structured_output: { confidence: 0.3 }, total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({
      name: 'classify',
      mode: 'structured',
      prompt: 'Classify',
      outputSchema: schema,
      mapResult: (output: unknown) => {
        const data = output as { confidence: number };
        return data.confidence > 0.5 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
      },
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('returns FAILURE on SDK error', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'error_during_execution' },
    ]) as any);

    const node = new AgentNode({
      name: 'classify',
      mode: 'structured',
      prompt: 'Classify',
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('supports dynamic prompts from context', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', structured_output: {}, total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({
      name: 'dynamic',
      mode: 'structured',
      prompt: (ctx) => `Analyze: ${ctx.blackboard.get('input')}`,
    });

    const ctx = createContext();
    ctx.blackboard.set('input', 'test data');
    await node.tick(ctx);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Analyze: test data',
      }),
    );
  });
});

describe('AgentNode - agentic mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns SUCCESS on successful agentic execution', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Working...' }] } },
      { type: 'result', subtype: 'success', result: 'Fixed the bug', total_cost_usd: 0.05 },
    ]) as any);

    const node = new AgentNode({
      name: 'fixer',
      mode: 'agentic',
      prompt: 'Fix the bug',
      allowedTools: ['Read', 'Edit'],
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns FAILURE on max_turns error', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'error_max_turns' },
    ]) as any);

    const node = new AgentNode({
      name: 'fixer',
      mode: 'agentic',
      prompt: 'Fix the bug',
      maxTurns: 5,
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('writes result text to blackboard', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'All tests pass', total_cost_usd: 0.02 },
    ]) as any);

    const node = new AgentNode({
      name: 'runner',
      mode: 'agentic',
      prompt: 'Run tests',
    });

    const ctx = createContext();
    await node.tick(ctx);
    expect(ctx.blackboard.get('runner:output')).toBe('All tests pass');
  });

  it('emits agent:response event', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.03 },
    ]) as any);

    const node = new AgentNode({
      name: 'worker',
      mode: 'agentic',
      prompt: 'Do work',
    });

    const ctx = createContext();
    const responseSpy = vi.fn();
    ctx.events.on('agent:response', responseSpy);
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
      mode: 'agentic',
      prompt: 'Read files',
    });

    const ctx = createContext();
    const toolSpy = vi.fn();
    ctx.events.on('agent:tool_use', toolSpy);
    await node.tick(ctx);

    expect(toolSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'Read', input: { file_path: 'test.ts' } }),
    );
  });
});
