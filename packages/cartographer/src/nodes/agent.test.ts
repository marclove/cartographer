import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import { SessionRegistry } from '../core/session-registry.js';
import type { TreeEvents } from '../types.js';
import type { AgentMessage, AgentSendOptions } from '../agent/agent.js';
import { TestAgent, createTestAgent } from '../agent/test-agent.js';
import { AgentNode } from './agent.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
    sessions: new SessionRegistry(),
  };
}

function createAgent(messages: AgentMessage[]): TestAgent {
  return createTestAgent(messages, { name: 'test-agent', info: { model: 'test-model' } });
}

describe('AgentNode - structured output', () => {
  it('returns SUCCESS on successful structured output', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { answer: 'yes' }, cost: 0.01 },
    ]);

    const node = new AgentNode({ name: 'classify', agent, prompt: 'Classify this input' });
    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('writes structured output to blackboard', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { answer: 'yes' }, cost: 0.01 },
    ]);

    const node = new AgentNode({ name: 'classify', agent, prompt: 'Classify this input' });
    const ctx = createContext();
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);
    expect(ctx.blackboard.get('classify:output')).toEqual({ answer: 'yes' });
  });

  it('uses mapResult to determine status', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: { confidence: 0.3 }, cost: 0.01 },
    ]);

    const node = new AgentNode({
      name: 'classify',
      agent,
      prompt: 'Classify',
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

  it('returns FAILURE on agent error', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'error', errors: ['Something went wrong'] },
    ]);

    const node = new AgentNode({ name: 'classify', agent, prompt: 'Classify' });
    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
  });

  it('supports dynamic prompts from context', async () => {
    let capturedPrompt: string | undefined;
    const agent = new TestAgent({ name: 'test' });
    agent.setMessages([
      { type: 'result', subtype: 'success', output: 'ok' },
    ]);
    const origSend = agent.send.bind(agent);
    agent.send = async function*(prompt: string, options?: AgentSendOptions) {
      capturedPrompt = prompt;
      yield* origSend(prompt, options);
    };

    const node = new AgentNode({
      name: 'dynamic',
      agent,
      prompt: (ctx) => `Analyze: ${ctx.blackboard.get('input')}`,
    });

    const ctx = createContext();
    ctx.blackboard.set('input', 'test data');
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(capturedPrompt).toBe('Analyze: test data');
  });
});

describe('AgentNode - unstructured output', () => {
  it('returns SUCCESS on successful execution', async () => {
    const agent = createAgent([
      { type: 'text', content: 'Working...' },
      { type: 'result', subtype: 'success', output: 'Fixed the bug', cost: 0.05 },
    ]);

    const node = new AgentNode({ name: 'fixer', agent, prompt: 'Fix the bug' });
    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('returns FAILURE on error result', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'error', errors: ['Exceeded maximum turns'] },
    ]);

    const node = new AgentNode({ name: 'fixer', agent, prompt: 'Fix the bug' });
    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
  });

  it('writes result output to blackboard', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: 'All tests pass', cost: 0.02 },
    ]);

    const node = new AgentNode({ name: 'runner', agent, prompt: 'Run tests' });
    const ctx = createContext();
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);
    expect(ctx.blackboard.get('runner:output')).toBe('All tests pass');
  });

  it('writes result to namespaced key when blackboardNamespace is set', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: 'namespaced result', cost: 0.02 },
    ]);

    const node = new AgentNode({
      name: 'runner',
      agent,
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
});

describe('AgentNode - observability events', () => {
  it('emits agent:prompt before sending', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: 'ok' },
    ]);

    const node = new AgentNode({ name: 'worker', agent, prompt: 'Do work' });
    const ctx = createContext();
    const promptSpy = vi.fn();
    ctx.events.on('agent:prompt', promptSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(promptSpy).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Do work' }),
    );
  });

  it('emits agent:thinking via onMessage', async () => {
    const agent = createAgent([
      { type: 'thinking', content: 'Let me reason...' },
      { type: 'result', subtype: 'success', output: 'done' },
    ]);

    const node = new AgentNode({ name: 'thinker', agent, prompt: 'Think' });
    const ctx = createContext();
    const thinkingSpy = vi.fn();
    ctx.events.on('agent:thinking', thinkingSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(thinkingSpy).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: 'Let me reason...' }),
    );
  });

  it('emits agent:text via onMessage', async () => {
    const agent = createAgent([
      { type: 'text', content: 'Working on it...' },
      { type: 'result', subtype: 'success', output: 'done' },
    ]);

    const node = new AgentNode({ name: 'worker', agent, prompt: 'Work' });
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

  it('emits agent:tool_use via onMessage', async () => {
    const agent = createAgent([
      { type: 'tool_use', name: 'Read', input: { file_path: 'test.ts' } },
      { type: 'result', subtype: 'success', output: 'done' },
    ]);

    const node = new AgentNode({ name: 'reader', agent, prompt: 'Read files' });
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

  it('emits agent:stream for stream messages', async () => {
    const agent = createAgent([
      { type: 'stream', event: { type: 'content_block_delta', delta: { text: 'hello' } } },
      { type: 'result', subtype: 'success', output: 'done' },
    ]);

    const node = new AgentNode({ name: 'streamer', agent, prompt: 'Stream' });
    const ctx = createContext();
    const streamSpy = vi.fn();
    ctx.events.on('agent:stream', streamSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(streamSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: { type: 'content_block_delta', delta: { text: 'hello' } } }),
    );
  });

  it('emits agent:rate_limit with { info } wrapper', async () => {
    const agent = createAgent([
      { type: 'provider_event', subtype: 'rate_limit', data: { info: { retryAfter: 5 } } },
      { type: 'result', subtype: 'success', output: 'done' },
    ]);

    const node = new AgentNode({ name: 'limited', agent, prompt: 'Work' });
    const ctx = createContext();
    const rateSpy = vi.fn();
    ctx.events.on('agent:rate_limit', rateSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(rateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ info: { retryAfter: 5 } }),
    );
  });

  it('emits agent:elicitation_declined when no handler is configured', async () => {
    // Agent that triggers elicitation via the onElicitation callback during send()
    const elicitAgent = new TestAgent({ name: 'elicit-agent' });
    const originalSend = elicitAgent.send.bind(elicitAgent);
    elicitAgent.send = async function* (prompt: string, options?: AgentSendOptions) {
      if (options?.onElicitation) {
        await options.onElicitation({ message: 'Allow?' });
      }
      yield* originalSend(prompt, options);
    };
    elicitAgent.setMessages([
      { type: 'result', subtype: 'success', output: 'done' },
    ]);

    const node = new AgentNode({ name: 'elicit', agent: elicitAgent, prompt: 'Work' });
    const ctx = createContext();
    // No onElicitation on context — wrapElicitation should auto-decline and emit
    const declineSpy = vi.fn();
    ctx.events.on('agent:elicitation_declined', declineSpy);
    await node.tick(ctx);

    expect(declineSpy).toHaveBeenCalledWith(
      expect.objectContaining({ request: { message: 'Allow?' } }),
    );
  });

  it('emits agent:response on success result', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: 'done', cost: 0.03 },
    ]);

    const node = new AgentNode({ name: 'worker', agent, prompt: 'Do work' });
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

  it('emits agent:error on error result', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'error', errors: ['Exceeded maximum turns'], cost: 0.05 },
    ]);

    const node = new AgentNode({ name: 'errorer', agent, prompt: 'Do stuff' });
    const ctx = createContext();
    const errorSpy = vi.fn();
    ctx.events.on('agent:error', errorSpy);
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        errors: ['Exceeded maximum turns'],
        cost: 0.05,
      }),
    );
  });
});

describe('AgentNode - caching', () => {
  it('returns cached status on subsequent ticks when cache: true', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: 'cached', cost: 0.01 },
    ]);

    const node = new AgentNode({
      name: 'cached',
      agent,
      prompt: 'Classify',
      cache: true,
    });

    const ctx = createContext();
    await node.tick(ctx);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);

    // Third tick should return cached without calling send again
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('reset() clears the cache', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: 'first', cost: 0.01 },
    ]);

    const node = new AgentNode({
      name: 'cached',
      agent,
      prompt: 'Classify',
      cache: true,
    });

    const ctx = createContext();
    await node.tick(ctx);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);

    node.reset();

    // After reset, should start a new inflight call
    agent.setMessages([
      { type: 'result', subtype: 'success', output: 'second', cost: 0.01 },
    ]);
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
  });
});

describe('AgentNode - serialize/restore', () => {
  it('serializes last terminal status', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: 'ok', cost: 0.01 },
    ]);

    const node = new AgentNode({ name: 'serializable', agent, prompt: 'Do work' });
    const ctx = createContext();
    await node.tick(ctx);
    await flush();
    await node.tick(ctx);

    const state = node.serialize();
    expect(state.lastStatus).toBe(NodeStatus.SUCCESS);
  });

  it('restores last terminal status', async () => {
    const agent = createAgent([]);
    const node = new AgentNode({ name: 'restorable', agent, prompt: 'Do work' });
    node.restore({ lastStatus: NodeStatus.FAILURE }, new Map());

    const state = node.serialize();
    expect(state.lastStatus).toBe(NodeStatus.FAILURE);
  });

  it('serializes empty object when no terminal status', () => {
    const agent = createAgent([]);
    const node = new AgentNode({ name: 'fresh', agent, prompt: 'Do work' });
    expect(node.serialize()).toEqual({});
  });
});

describe('AgentNode - abort/interrupt', () => {
  it('abort() clears inflight state', async () => {
    // Agent that never yields a result (simulates long-running)
    const agent = new TestAgent({ name: 'slow' });
    const neverResolve = new Promise<AgentMessage>(() => {});
    agent.send = async function*() {
      yield await neverResolve;
    };

    const node = new AgentNode({ name: 'abortable', agent, prompt: 'Do work' });
    const ctx = createContext();
    await node.tick(ctx); // starts inflight

    node.abort();

    // After abort, next tick should start fresh (not poll old inflight)
    agent.setMessages([
      { type: 'result', subtype: 'success', output: 'ok' },
    ]);
    // Reset the send to use setMessages again
    agent.send = TestAgent.prototype.send.bind(agent);
    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
  });

  it('interrupt() preserves cached status', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: 'cached', cost: 0.01 },
    ]);

    const node = new AgentNode({
      name: 'interruptible',
      agent,
      prompt: 'Classify',
      cache: true,
    });

    const ctx = createContext();
    await node.tick(ctx);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);

    node.interrupt();

    // Cached status should survive interrupt
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });
});

describe('AgentNode - agentOptions', () => {
  it('delegates to agent.getInfo()', () => {
    const agent = new TestAgent({ name: 'my-agent', info: { model: 'test-model' } });
    const node = new AgentNode({ name: 'node', agent, prompt: 'test' });

    const info = node.agentOptions;
    expect(info.name).toBe('my-agent');
    expect(info.model).toBe('test-model');
  });
});

describe('AgentNode - sessions', () => {
  it('registers a new session when resuming a session that does not exist yet', async () => {
    const agent = createAgent([
      { type: 'session_start', sessionId: 'sess-abc' },
      { type: 'result', subtype: 'success', output: 'done' },
    ]);

    const node = new AgentNode({ name: 'worker', agent, prompt: 'Work', session: 'triage' });
    const ctx = createContext();

    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);

    expect(ctx.sessions.get('triage')).toBe('sess-abc');
  });

  it('passes existing session ID when resuming', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: 'done' },
    ]);

    let capturedOpts: AgentSendOptions | undefined;
    const origSend = agent.send.bind(agent);
    agent.send = async function*(prompt: string, options?: AgentSendOptions) {
      capturedOpts = options;
      yield* origSend(prompt, options);
    };

    const node = new AgentNode({ name: 'worker', agent, prompt: 'Work', session: 'triage' });
    const ctx = createContext();
    ctx.sessions.set('triage', 'existing-sess-id');

    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    await node.tick(ctx);

    expect(capturedOpts?.session).toEqual({ id: 'existing-sess-id' });
  });

  it('passes fork option when forking an existing session', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: 'done' },
    ]);

    let capturedOpts: AgentSendOptions | undefined;
    const origSend = agent.send.bind(agent);
    agent.send = async function*(prompt: string, options?: AgentSendOptions) {
      capturedOpts = options;
      yield* origSend(prompt, options);
    };

    const node = new AgentNode({
      name: 'worker',
      agent,
      prompt: 'Work',
      session: { name: 'triage', fork: true },
    });
    const ctx = createContext();
    ctx.sessions.set('triage', 'base-sess-id');

    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    await node.tick(ctx);

    expect(capturedOpts?.session).toEqual({ id: 'base-sess-id', fork: true });
  });

  it('registers a named fork under the fork name', async () => {
    const agent = createAgent([
      { type: 'session_start', sessionId: 'forked-sess-id' },
      { type: 'result', subtype: 'success', output: 'done' },
    ]);

    const node = new AgentNode({
      name: 'worker',
      agent,
      prompt: 'Work',
      session: { name: 'triage', fork: 'triage-branch' },
    });
    const ctx = createContext();
    ctx.sessions.set('triage', 'base-sess-id');

    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    await node.tick(ctx);

    expect(ctx.sessions.get('triage-branch')).toBe('forked-sess-id');
    // Original session should be unchanged
    expect(ctx.sessions.get('triage')).toBe('base-sess-id');
  });

  it('does not register an anonymous fork', async () => {
    const agent = createAgent([
      { type: 'session_start', sessionId: 'ephemeral-sess-id' },
      { type: 'result', subtype: 'success', output: 'done' },
    ]);

    const node = new AgentNode({
      name: 'worker',
      agent,
      prompt: 'Work',
      session: { name: 'triage', fork: true },
    });
    const ctx = createContext();
    ctx.sessions.set('triage', 'base-sess-id');

    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    await node.tick(ctx);

    // Only 'triage' should exist — the ephemeral fork ID must not be registered
    expect(ctx.sessions.get('triage')).toBe('base-sess-id');
    expect(ctx.sessions.get('ephemeral-sess-id')).toBeUndefined();
  });

  it('returns FAILURE when forking a session that does not exist', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: 'done' },
    ]);

    const node = new AgentNode({
      name: 'worker',
      agent,
      prompt: 'Work',
      session: { name: 'nonexistent', fork: true },
    });
    const ctx = createContext();

    // The throw from resolveSessionOptions is synchronous in execute(),
    // so BaseNode.tick() catches it and returns FAILURE directly
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
  });

  it('does not use registry when no session config is set', async () => {
    const agent = createAgent([
      { type: 'result', subtype: 'success', output: 'done' },
    ]);

    let capturedOpts: AgentSendOptions | undefined;
    const origSend = agent.send.bind(agent);
    agent.send = async function*(prompt: string, options?: AgentSendOptions) {
      capturedOpts = options;
      yield* origSend(prompt, options);
    };

    const node = new AgentNode({ name: 'worker', agent, prompt: 'Work' });
    const ctx = createContext();

    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    await node.tick(ctx);

    expect(capturedOpts?.session).toBeUndefined();
  });

  it('accepts string shorthand for session config', async () => {
    const agent = createAgent([
      { type: 'session_start', sessionId: 'new-sess-id' },
      { type: 'result', subtype: 'success', output: 'done' },
    ]);

    const node = new AgentNode({ name: 'worker', agent, prompt: 'Work', session: 'my-session' });
    const ctx = createContext();

    expect(node.sessionConfig).toEqual({ name: 'my-session' });

    expect(await node.tick(ctx)).toBe(NodeStatus.RUNNING);
    await flush();
    await node.tick(ctx);

    expect(ctx.sessions.get('my-session')).toBe('new-sess-id');
  });
});
