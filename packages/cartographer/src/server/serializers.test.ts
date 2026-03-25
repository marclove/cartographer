import { describe, it, expect } from 'vitest';
import { serializeNodeRef, serializeTree, getNodeType, serializeEvent } from './serializers.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { ParallelNode } from '../composites/parallel.js';
import { NodeStatus } from '../types.js';
import { InverterNode } from '../decorators/inverter.js';

const dummyAction = new ActionNode({ name: 'DoStuff', id: 'do-stuff', action: async () => NodeStatus.SUCCESS });
const dummyCondition = new ConditionNode({ name: 'IsReady', id: 'is-ready', condition: async () => true });

describe('getNodeType', () => {
  it('returns correct type for leaf nodes', () => {
    expect(getNodeType(dummyAction)).toBe('action');
    expect(getNodeType(dummyCondition)).toBe('condition');
  });

  it('returns correct type for composites', () => {
    const seq = new SequenceNode({ name: 'Seq', id: 'seq', children: [] });
    expect(getNodeType(seq)).toBe('sequence');
    const sel = new SelectorNode({ name: 'Sel', id: 'sel', children: [] });
    expect(getNodeType(sel)).toBe('selector');
    const par = new ParallelNode({ name: 'Par', id: 'par', children: [] });
    expect(getNodeType(par)).toBe('parallel');
  });

  it('returns decorator for decorator nodes', () => {
    const inv = new InverterNode({ name: 'Inv', id: 'inv', child: dummyAction });
    expect(getNodeType(inv)).toBe('decorator');
  });
});

describe('serializeNodeRef', () => {
  it('returns id, name, and type', () => {
    expect(serializeNodeRef(dummyAction)).toEqual({ id: 'do-stuff', name: 'DoStuff', type: 'action' });
  });
});

describe('serializeTree', () => {
  it('recursively serializes node hierarchy', () => {
    const child1 = new ActionNode({ name: 'A', id: 'a', action: async () => NodeStatus.SUCCESS });
    const child2 = new ConditionNode({ name: 'B', id: 'b', condition: async () => true });
    const root = new SequenceNode({ name: 'Root', id: 'root', children: [child1, child2] });

    expect(serializeTree(root)).toEqual({
      id: 'root',
      name: 'Root',
      type: 'sequence',
      children: [
        { id: 'a', name: 'A', type: 'action', children: [] },
        { id: 'b', name: 'B', type: 'condition', children: [] },
      ],
    });
  });
});

describe('serializeEvent', () => {
  it('serializes node:enter — strips BTreeNode and TreeContext, keeps serializable fields', () => {
    const result = serializeEvent('node:enter', {
      node: dummyAction,
      context: {} as any,
    });
    expect(result).toEqual({
      node: { id: 'do-stuff', name: 'DoStuff', type: 'action' },
    });
  });

  it('serializes node:exit — includes status and durationMs', () => {
    const result = serializeEvent('node:exit', {
      node: dummyAction,
      status: NodeStatus.SUCCESS,
      context: {} as any,
      durationMs: 42,
    });
    expect(result).toEqual({
      node: { id: 'do-stuff', name: 'DoStuff', type: 'action' },
      status: 'success',
      durationMs: 42,
    });
  });

  it('serializes agent:thinking — includes text', () => {
    const result = serializeEvent('agent:thinking', {
      node: dummyAction,
      thinking: 'Let me think...',
    });
    expect(result).toEqual({
      nodeId: 'do-stuff',
      text: 'Let me think...',
    });
  });

  it('serializes tree:tick — passes through directly', () => {
    const result = serializeEvent('tree:tick', {
      tree: 'MyTree',
      status: NodeStatus.SUCCESS,
      durationMs: 100,
    });
    expect(result).toEqual({
      tree: 'MyTree',
      status: 'success',
      durationMs: 100,
    });
  });

  it('serializes blackboard:keys — passes through directly', () => {
    const result = serializeEvent('blackboard:keys', {
      keys: ['a', 'b'],
      source: 'blackboard',
    });
    expect(result).toEqual({
      keys: ['a', 'b'],
      source: 'blackboard',
    });
  });

  it('serializes blackboard:read — passes through directly', () => {
    const result = serializeEvent('blackboard:read', {
      key: 'foo',
      value: 42,
      hit: true,
      source: 'blackboard',
    });
    expect(result).toEqual({
      key: 'foo',
      value: 42,
      hit: true,
      source: 'blackboard',
    });
  });

  it('serializes blackboard:write — passes through directly', () => {
    const result = serializeEvent('blackboard:write', {
      key: 'foo',
      value: 42,
      source: 'test',
    });
    expect(result).toEqual({
      key: 'foo',
      value: 42,
      source: 'test',
    });
  });

  it('serializes blackboard:delete — passes through directly', () => {
    const result = serializeEvent('blackboard:delete', {
      key: 'foo',
      source: 'blackboard',
    });
    expect(result).toEqual({
      key: 'foo',
      source: 'blackboard',
    });
  });

  it('serializes node:error — extracts error message', () => {
    const result = serializeEvent('node:error', {
      node: dummyAction,
      error: new Error('something broke'),
      context: {} as any,
    });
    expect(result).toEqual({
      node: { id: 'do-stuff', name: 'DoStuff', type: 'action' },
      error: 'something broke',
    });
  });

  it('serializes agent:text — returns nodeId and text', () => {
    const result = serializeEvent('agent:text', {
      node: dummyAction,
      text: 'Hello world',
    });
    expect(result).toEqual({
      nodeId: 'do-stuff',
      text: 'Hello world',
    });
  });

  it('serializes agent:tool_use — returns nodeId, tool, and input', () => {
    const result = serializeEvent('agent:tool_use', {
      node: dummyAction,
      tool: 'bash',
      input: { command: 'ls' },
    });
    expect(result).toEqual({
      nodeId: 'do-stuff',
      tool: 'bash',
      input: { command: 'ls' },
    });
  });

  it('serializes agent:response — returns nodeId, result, cost, and modelUsage', () => {
    const result = serializeEvent('agent:response', {
      node: dummyAction,
      result: 'done',
      cost: 0.05,
      modelUsage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(result).toEqual({
      nodeId: 'do-stuff',
      result: 'done',
      cost: 0.05,
      modelUsage: { input_tokens: 100, output_tokens: 50 },
    });
  });

  it('serializes agent:error — returns nodeId, subtype, errors, permissionDenials, cost, modelUsage', () => {
    const result = serializeEvent('agent:error', {
      node: dummyAction,
      subtype: 'tool_error',
      errors: ['bad input'],
      permissionDenials: [],
      cost: 0.01,
      modelUsage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(result).toEqual({
      nodeId: 'do-stuff',
      subtype: 'tool_error',
      errors: ['bad input'],
      permissionDenials: [],
      cost: 0.01,
      modelUsage: { input_tokens: 10, output_tokens: 5 },
    });
  });

  it('serializes agent:message — returns nodeId and message', () => {
    const result = serializeEvent('agent:message', {
      node: dummyAction,
      message: { role: 'assistant', content: 'hi' },
    });
    expect(result).toEqual({
      nodeId: 'do-stuff',
      message: { role: 'assistant', content: 'hi' },
    });
  });

  it('serializes agent:tool_progress — returns nodeId, toolUseId, toolName, elapsedSeconds', () => {
    const result = serializeEvent('agent:tool_progress', {
      node: dummyAction,
      toolUseId: 'tu-123',
      toolName: 'bash',
      elapsedSeconds: 3.5,
    });
    expect(result).toEqual({
      nodeId: 'do-stuff',
      toolUseId: 'tu-123',
      toolName: 'bash',
      elapsedSeconds: 3.5,
    });
  });

  it('serializes agent:init — returns nodeId, sessionId, model, tools, mcpServers', () => {
    const result = serializeEvent('agent:init', {
      node: dummyAction,
      sessionId: 'sess-1',
      model: 'claude-sonnet-4-20250514',
      tools: ['bash', 'read'],
      mcpServers: ['mcp-1'],
    });
    expect(result).toEqual({
      nodeId: 'do-stuff',
      sessionId: 'sess-1',
      model: 'claude-sonnet-4-20250514',
      tools: ['bash', 'read'],
      mcpServers: ['mcp-1'],
    });
  });

  it('serializes agent:status — returns nodeId and status', () => {
    const result = serializeEvent('agent:status', {
      node: dummyAction,
      status: 'running',
    });
    expect(result).toEqual({
      nodeId: 'do-stuff',
      status: 'running',
    });
  });

  it('serializes agent:rate_limit — returns nodeId and info', () => {
    const result = serializeEvent('agent:rate_limit', {
      node: dummyAction,
      info: { retryAfter: 30 },
    });
    expect(result).toEqual({
      nodeId: 'do-stuff',
      info: { retryAfter: 30 },
    });
  });

  it('serializes agent:stream — returns nodeId and event', () => {
    const result = serializeEvent('agent:stream', {
      node: dummyAction,
      event: { type: 'content_block_delta', delta: { text: 'hi' } },
    });
    expect(result).toEqual({
      nodeId: 'do-stuff',
      event: { type: 'content_block_delta', delta: { text: 'hi' } },
    });
  });

  it('serializes agent:elicitation_declined — returns nodeId and request', () => {
    const result = serializeEvent('agent:elicitation_declined', {
      node: dummyAction,
      request: { question: 'proceed?' },
    });
    expect(result).toEqual({
      nodeId: 'do-stuff',
      request: { question: 'proceed?' },
    });
  });

  it('serializes agent:prompt — returns nodeId and prompt', () => {
    const result = serializeEvent('agent:prompt', {
      node: dummyAction,
      prompt: 'Do the thing',
    });
    expect(result).toEqual({
      nodeId: 'do-stuff',
      prompt: 'Do the thing',
    });
  });

  it('serializes tree:tick:skipped — returns timestamp', () => {
    const result = serializeEvent('tree:tick:skipped', {
      timestamp: 1234567890,
    });
    expect(result).toEqual({
      timestamp: 1234567890,
    });
  });

  it('serializes strategy:decision — returns compositeId, strategy, and decision', () => {
    const seq = new SequenceNode({ name: 'Seq', id: 'seq-1', children: [] });
    const result = serializeEvent('strategy:decision', {
      composite: seq,
      strategy: 'agent-priority',
      decision: { order: [0, 1, 2] },
    });
    expect(result).toEqual({
      compositeId: 'seq-1',
      strategy: 'agent-priority',
      decision: { order: [0, 1, 2] },
    });
  });

  it('falls through to spread pass-through for unknown event types', () => {
    const result = serializeEvent('some:unknown:event' as any, {
      foo: 'bar',
      num: 99,
    });
    expect(result).toEqual({ foo: 'bar', num: 99 });
  });
});

describe('getNodeType — unknown', () => {
  it('returns unknown for an unrecognized node type', () => {
    const fakeNode = {
      id: 'fake-1',
      name: 'FakeNode',
      children: [] as any[],
      tick: async () => NodeStatus.SUCCESS,
      reset: () => {},
      abort: () => {},
    };
    expect(getNodeType(fakeNode as any)).toBe('unknown');
  });
});
