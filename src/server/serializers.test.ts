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
});
