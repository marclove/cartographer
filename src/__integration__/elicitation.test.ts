import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeBuilder } from '../builder/tree-builder.js';
import { NodeStatus } from '../types.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => handler),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';

const mockQuery = vi.mocked(query);

const testRequest = {
  serverName: 'test-mcp-server',
  message: 'Please authenticate',
  mode: 'form' as const,
  requestedSchema: { type: 'object', properties: { token: { type: 'string' } } },
};

function setupMockQuery() {
  mockQuery.mockImplementation(async function* (args: any) {
    const handler = args.options.onElicitation;
    if (handler) {
      await handler(testRequest, { signal: new AbortController().signal });
    }
    yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 };
  } as any);
}

describe('Elicitation integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMockQuery();
  });

  it('tree-level onElicitation is inherited by AgentNodes', async () => {
    const handler = vi.fn().mockResolvedValue({ action: 'accept', content: { token: 'abc' } });

    const tree = new TreeBuilder('test')
      .onElicitation(handler)
      .sequence('root', (b) => {
        b.agent('worker', { prompt: 'do work' });
      })
      .build();

    await tree.tick();

    expect(handler).toHaveBeenCalledWith(
      testRequest,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('subtree context override takes precedence over tree-level', async () => {
    const treeHandler = vi.fn().mockResolvedValue({ action: 'accept' });
    const subtreeHandler = vi.fn().mockResolvedValue({ action: 'accept' });

    const tree = new TreeBuilder('test')
      .onElicitation(treeHandler)
      .sequence('root', (b) => {
        b.sequence('scoped', { context: { onElicitation: subtreeHandler } }, (b) => {
          b.agent('inner-agent', { prompt: 'inner work' });
        });
      })
      .build();

    await tree.tick();

    expect(subtreeHandler).toHaveBeenCalled();
    expect(treeHandler).not.toHaveBeenCalled();
  });

  it('emits agent:elicitation_declined when no handler exists at any level', async () => {
    const tree = new TreeBuilder('test')
      .sequence('root', (b) => {
        b.agent('worker', { prompt: 'do work' });
      })
      .build();

    const declineSpy = vi.fn();
    tree.events.on('agent:elicitation_declined', declineSpy);

    await tree.tick();

    expect(declineSpy).toHaveBeenCalledWith(
      expect.objectContaining({ request: testRequest }),
    );
  });

  it('node-level options.onElicitation overrides context-level', async () => {
    const treeHandler = vi.fn().mockResolvedValue({ action: 'accept' });
    const nodeHandler = vi.fn().mockResolvedValue({ action: 'accept' });

    const tree = new TreeBuilder('test')
      .onElicitation(treeHandler)
      .sequence('root', (b) => {
        b.agent('worker', { prompt: 'do work', options: { onElicitation: nodeHandler } });
      })
      .build();

    await tree.tick();

    expect(nodeHandler).toHaveBeenCalled();
    expect(treeHandler).not.toHaveBeenCalled();
  });

  it('deeply nested AgentNode inherits from grandparent context override', async () => {
    const handler = vi.fn().mockResolvedValue({ action: 'accept' });

    const tree = new TreeBuilder('test')
      .sequence('root', { context: { onElicitation: handler } }, (b) => {
        b.retry('with-retry', { maxAttempts: 2 }, (b) => {
          b.agent('deep-agent', { prompt: 'deep work' });
        });
      })
      .build();

    await tree.tick();

    expect(handler).toHaveBeenCalled();
  });

  it('events always emit to tree-level emitter regardless of context overrides', async () => {
    const handler = vi.fn().mockResolvedValue({ action: 'accept' });

    const tree = new TreeBuilder('test')
      .onElicitation(handler)
      .sequence('root', (b) => {
        b.agent('worker', { prompt: 'do work' });
      })
      .build();

    const enterSpy = vi.fn();
    tree.events.on('node:enter', enterSpy);

    await tree.tick();

    // All node:enter events should be on the tree-level emitter
    expect(enterSpy.mock.calls.length).toBeGreaterThan(0);
  });
});
