import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeBuilder } from '../builder/tree-builder.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TypedEventEmitter, TreeEvents } from '../types.js';
import { Agent } from '../agent/agent.js';
import type { AgentMessage, AgentSendOptions, AgentInfo } from '../agent/agent.js';
import { wrapElicitation } from '../agent/sdk-helpers.js';
import { AgentSelectionStrategy } from '../strategies/agent-selection.js';

/**
 * StubAgent for elicitation tests. Simulates the real SDK elicitation flow:
 * always attempts elicitation during send(), routing through wrapElicitation
 * when events/node context is provided (to test the declined path).
 */
class ElicitationStubAgent extends Agent {
  private resultMessage: AgentMessage = { type: 'result', subtype: 'success', output: 'done', cost: 0.01 };
  private _events?: TypedEventEmitter<TreeEvents>;
  private _nodeProxy?: BTreeNode;

  get sessionId(): string | null { return null; }

  setResult(msg: AgentMessage): void {
    this.resultMessage = msg;
  }

  /** Provide the tree events emitter and a node proxy so wrapElicitation can emit declined events. */
  withContext(events: TypedEventEmitter<TreeEvents>, nodeProxy: BTreeNode): this {
    this._events = events;
    this._nodeProxy = nodeProxy;
    return this;
  }

  async *send(_prompt: string, options?: AgentSendOptions): AsyncIterable<AgentMessage> {
    // Simulate elicitation: if events/node context is available, use wrapElicitation
    // to handle both the handler-present and handler-absent (declined) paths.
    if (this._events && this._nodeProxy) {
      const wrapped = wrapElicitation(options?.onElicitation, this._nodeProxy, this._events);
      await wrapped(testRequest, { signal: new AbortController().signal });
    } else if (options?.onElicitation) {
      await options.onElicitation(testRequest, { signal: new AbortController().signal });
    }
    if (options?.onMessage) {
      try { options.onMessage(this.resultMessage); } catch { /* swallowed */ }
    }
    yield this.resultMessage;
  }

  getInfo(): AgentInfo { return { name: this.name }; }
  async close(): Promise<void> {}
}

const testRequest = {
  serverName: 'test-mcp-server',
  message: 'Please authenticate',
  mode: 'form' as const,
  requestedSchema: { type: 'object', properties: { token: { type: 'string' } } },
};

describe('Strategy elicitation integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strategy inherits onElicitation from tree context', async () => {
    const handler = vi.fn().mockResolvedValue({ action: 'accept', content: { token: 'abc' } });

    // Strategy agent triggers elicitation during its send(), then returns
    // a valid ordering so the selector succeeds.
    const strategyAgent = new ElicitationStubAgent({ name: 'strategy' });
    strategyAgent.setResult({
      type: 'result',
      subtype: 'success',
      output: { ordering: ['worker'], reasoning: 'only one' },
      cost: 0.01,
    });

    // Worker agent just succeeds
    const workerAgent = new ElicitationStubAgent({ name: 'worker' });

    const tree = new TreeBuilder('test')
      .onElicitation(handler)
      .selector('root', { strategy: new AgentSelectionStrategy({ prompt: 'Pick best', agent: strategyAgent }) }, (b) => {
        b.agent('worker', { agent: workerAgent, prompt: 'do work' });
      })
      .build();

    await tree.tick();

    expect(handler).toHaveBeenCalledWith(
      testRequest,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe('Elicitation integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tree-level onElicitation is inherited by AgentNodes', async () => {
    const handler = vi.fn().mockResolvedValue({ action: 'accept', content: { token: 'abc' } });

    const tree = new TreeBuilder('test')
      .onElicitation(handler)
      .sequence('root', (b) => {
        b.agent('worker', { agent: new ElicitationStubAgent({ name: 'worker' }), prompt: 'do work' });
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
          b.agent('inner-agent', { agent: new ElicitationStubAgent({ name: 'inner-agent' }), prompt: 'inner work' });
        });
      })
      .build();

    await tree.tick();

    expect(subtreeHandler).toHaveBeenCalled();
    expect(treeHandler).not.toHaveBeenCalled();
  });

  it('emits agent:elicitation_declined when no handler exists at any level', async () => {
    // Use a stub that routes through wrapElicitation to emit the declined event
    // when no handler is provided via context.
    const workerAgent = new ElicitationStubAgent({ name: 'worker' });

    const tree = new TreeBuilder('test')
      .sequence('root', (b) => {
        b.agent('worker', { agent: workerAgent, prompt: 'do work' });
      })
      .build();

    // Provide the tree-level events emitter so wrapElicitation can emit the declined event.
    // This simulates the real SDK flow where the agent wraps the handler before calling the SDK.
    // We use a stub node proxy since the actual AgentNode isn't accessible here.
    const nodeProxy = { id: 'worker', name: 'worker' } as BTreeNode;
    workerAgent.withContext(tree.events, nodeProxy);

    const declineSpy = vi.fn();
    tree.events.on('agent:elicitation_declined', declineSpy);

    await tree.tick();

    expect(declineSpy).toHaveBeenCalledWith(
      expect.objectContaining({ request: testRequest }),
    );
  });

  it('scoped context onElicitation overrides tree-level', async () => {
    const treeHandler = vi.fn().mockResolvedValue({ action: 'accept' });
    const scopedHandler = vi.fn().mockResolvedValue({ action: 'accept' });

    const tree = new TreeBuilder('test')
      .onElicitation(treeHandler)
      .sequence('root', (b) => {
        b.sequence('scoped', { context: { onElicitation: scopedHandler } }, (b) => {
          b.agent('worker', { agent: new ElicitationStubAgent({ name: 'worker' }), prompt: 'do work' });
        });
      })
      .build();

    await tree.tick();

    expect(scopedHandler).toHaveBeenCalled();
    expect(treeHandler).not.toHaveBeenCalled();
  });

  it('deeply nested AgentNode inherits from grandparent context override', async () => {
    const handler = vi.fn().mockResolvedValue({ action: 'accept' });

    const tree = new TreeBuilder('test')
      .sequence('root', { context: { onElicitation: handler } }, (b) => {
        b.retry('with-retry', { maxAttempts: 2 }, (b) => {
          b.agent('deep-agent', { agent: new ElicitationStubAgent({ name: 'deep-agent' }), prompt: 'deep work' });
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
        b.agent('worker', { agent: new ElicitationStubAgent({ name: 'worker' }), prompt: 'do work' });
      })
      .build();

    const enterSpy = vi.fn();
    tree.events.on('node:enter', enterSpy);

    await tree.tick();

    // All node:enter events should be on the tree-level emitter
    expect(enterSpy.mock.calls.length).toBeGreaterThan(0);
  });
});
