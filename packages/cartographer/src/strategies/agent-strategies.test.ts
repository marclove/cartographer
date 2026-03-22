import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';
import { Agent } from '../agent/agent.js';
import type { AgentMessage, AgentSendOptions, AgentInfo } from '../agent/agent.js';

import { AgentSelectionStrategy } from './agent-selection.js';
import { AgentExecutionStrategy } from './agent-execution.js';
import { AgentParallelStrategy } from './agent-parallel.js';

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
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

class TestAgent extends Agent {
  private messages: AgentMessage[] = [];
  sendSpy = vi.fn();

  setMessages(msgs: AgentMessage[]): void {
    this.messages = msgs;
  }

  get sessionId(): string | null { return null; }

  async *send(prompt: string, options?: AgentSendOptions): AsyncIterable<AgentMessage> {
    this.sendSpy(prompt, options);
    for (const msg of this.messages) {
      if (options?.onMessage) {
        try { options.onMessage(msg); } catch { /* swallowed */ }
      }
      yield msg;
    }
  }

  getInfo(): AgentInfo { return { name: this.name }; }
  async close(): Promise<void> {}
}

function createAgent(messages: AgentMessage[]): TestAgent {
  const agent = new TestAgent({ name: 'test-agent' });
  agent.setMessages(messages);
  return agent;
}

describe('AgentSelectionStrategy', () => {
  it('reorders children based on agent response', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { ordering: ['c', 'a', 'b'], reasoning: 'c is most relevant' } },
    ]);

    const strategy = new AgentSelectionStrategy({
      prompt: 'Pick the best order',
      childDescriptions: { a: 'first', b: 'second', c: 'third' },
      agent,
    });

    const children = [mockNode('a'), mockNode('b'), mockNode('c')];
    const result = await strategy.order(children, createContext());
    expect(result.map((n) => n.name)).toEqual(['c', 'a', 'b']);
  });

  it('falls back to original order on agent failure', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'error', errors: ['something broke'] },
    ]);

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick order', agent });
    const children = [mockNode('a'), mockNode('b')];
    const result = await strategy.order(children, createContext());
    expect(result.map((n) => n.name)).toEqual(['a', 'b']);
  });

  it('falls back to original order if agent returns unknown names', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { ordering: ['x', 'y', 'z'], reasoning: 'random' } },
    ]);

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick order', agent });
    const children = [mockNode('a'), mockNode('b')];
    const result = await strategy.order(children, createContext());
    expect(result.map((n) => n.name)).toEqual(['a', 'b']);
  });

  it('emits strategy:decision event', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { ordering: ['a'], reasoning: 'only one' } },
    ]);

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick', agent });
    const ctx = createContext();
    const spy = vi.fn();
    ctx.events.on('strategy:decision', spy);
    await strategy.order([mockNode('a')], ctx);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'agent-selection' }),
    );
  });

  it('supports dynamic prompt function', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { ordering: ['a'], reasoning: 'ok' } },
    ]);

    const strategy = new AgentSelectionStrategy({
      prompt: (children, ctx) => `Choose from ${children.length} options, state: ${ctx.blackboard.get('state')}`,
      agent,
    });

    const ctx = createContext();
    ctx.blackboard.set('state', 'active');
    await strategy.order([mockNode('a')], ctx);
    expect(agent.sendSpy).toHaveBeenCalled();
  });

  it('emits agent:prompt before calling agent', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { ordering: ['a'], reasoning: 'ok' } },
    ]);

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick', agent });
    const ctx = createContext();
    const spy = vi.fn();
    ctx.events.on('agent:prompt', spy);
    await strategy.order([mockNode('a')], ctx);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.any(String) }),
    );
    expect(spy.mock.calls[0][0].prompt).toContain('Pick');
  });

  it('passes outputSchema to agent.send()', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { ordering: ['a'], reasoning: 'ok' } },
    ]);

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick', agent });
    await strategy.order([mockNode('a')], createContext());

    const sendOptions = agent.sendSpy.mock.calls[0][1];
    expect(sendOptions.outputSchema).toBeDefined();
    expect(sendOptions.outputSchema.type).toBe('object');
  });

  it('passes onMessage to agent.send()', async () => {
    const agent = createAgent([
      { type: 'thinking', content: 'Let me consider...' },
      { type: 'result', subtype: 'success', output: { ordering: ['a'], reasoning: 'ok' } },
    ]);

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick', agent });
    const ctx = createContext();
    const thinkingSpy = vi.fn();
    ctx.events.on('agent:thinking', thinkingSpy);
    await strategy.order([mockNode('a')], ctx);

    // onMessage should have been called, emitting agent:thinking
    const sendOptions = agent.sendSpy.mock.calls[0][1];
    expect(sendOptions.onMessage).toBeDefined();
  });

  it('passes context.signal to agent.send()', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { ordering: ['a'], reasoning: 'ok' } },
    ]);

    const ac = new AbortController();
    const ctx = createContext();
    ctx.signal = ac.signal;

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick', agent });
    await strategy.order([mockNode('a')], ctx);

    const sendOptions = agent.sendSpy.mock.calls[0][1];
    expect(sendOptions.signal).toBe(ac.signal);
  });
});

describe('AgentExecutionStrategy', () => {
  it('reorders children based on agent response', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { ordering: ['b', 'a'], reasoning: 'b first' } },
    ]);

    const strategy = new AgentExecutionStrategy({ prompt: 'Order steps', agent });
    const children = [mockNode('a'), mockNode('b')];
    const result = await strategy.order(children, createContext());
    expect(result.map((n) => n.name)).toEqual(['b', 'a']);
  });

  it('falls back to original order on failure', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'error', errors: ['failed'] },
    ]);

    const strategy = new AgentExecutionStrategy({ prompt: 'Order', agent });
    const children = [mockNode('a'), mockNode('b')];
    const result = await strategy.order(children, createContext());
    expect(result.map((n) => n.name)).toEqual(['a', 'b']);
  });

  it('returns cached order on second call without calling agent again', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { ordering: ['b', 'a'], reasoning: 'b first' } },
    ]);

    const strategy = new AgentExecutionStrategy({ prompt: 'Order steps', cache: true, agent });
    const children = [mockNode('a'), mockNode('b')];
    const ctx = createContext();

    const first = await strategy.order(children, ctx);
    expect(first.map((n) => n.name)).toEqual(['b', 'a']);
    expect(agent.sendSpy).toHaveBeenCalledTimes(1);

    const second = await strategy.order(children, ctx);
    expect(second.map((n) => n.name)).toEqual(['b', 'a']);
    expect(agent.sendSpy).toHaveBeenCalledTimes(1);
  });

  it('reset() clears cache so agent is called again', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { ordering: ['b', 'a'], reasoning: 'b first' } },
    ]);

    const strategy = new AgentExecutionStrategy({ prompt: 'Order steps', cache: true, agent });
    const children = [mockNode('a'), mockNode('b')];
    const ctx = createContext();

    await strategy.order(children, ctx);
    expect(agent.sendSpy).toHaveBeenCalledTimes(1);

    strategy.reset();

    await strategy.order(children, ctx);
    expect(agent.sendSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to original order when agent returns unrecognised names', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { ordering: ['nonexistent'], reasoning: 'wrong' } },
    ]);

    const strategy = new AgentExecutionStrategy({ prompt: 'Order steps', agent });
    const children = [mockNode('a'), mockNode('b')];
    const result = await strategy.order(children, createContext());
    expect(result.map((n) => n.name)).toEqual(['a', 'b']);
  });
});

describe('AgentParallelStrategy', () => {
  it('returns policy from agent response', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { policy: { successCount: 2 }, reasoning: 'need at least 2' } },
    ]);

    const strategy = new AgentParallelStrategy({ prompt: 'Set policy', agent });
    const children = [mockNode('a'), mockNode('b'), mockNode('c')];
    const result = await strategy.policy(children, createContext());
    expect(result).toEqual({ successCount: 2 });
  });

  it('falls back to require-all policy on failure', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'error', errors: ['failed'] },
    ]);

    const strategy = new AgentParallelStrategy({ prompt: 'Set policy', agent });
    const children = [mockNode('a'), mockNode('b')];
    const result = await strategy.policy(children, createContext());
    expect(result).toEqual({ successCount: 2 });
  });

  it('emits strategy:decision event', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { policy: { successCount: 1 }, reasoning: 'ok' } },
    ]);

    const strategy = new AgentParallelStrategy({ prompt: 'Set policy', agent });
    const ctx = createContext();
    const spy = vi.fn();
    ctx.events.on('strategy:decision', spy);
    await strategy.policy([mockNode('a')], ctx);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'agent-parallel' }),
    );
  });

  it('passes context.signal to agent.send()', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { policy: { successCount: 1 }, reasoning: 'ok' } },
    ]);

    const ac = new AbortController();
    const ctx = createContext();
    ctx.signal = ac.signal;

    const strategy = new AgentParallelStrategy({ prompt: 'Set policy', agent });
    await strategy.policy([mockNode('a')], ctx);

    const sendOptions = agent.sendSpy.mock.calls[0][1];
    expect(sendOptions.signal).toBe(ac.signal);
  });
});
