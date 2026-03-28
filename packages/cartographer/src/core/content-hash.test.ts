import { describe, it, expect } from 'vitest';
import { computeContentHash } from './content-hash.js';
import { BehaviorTree } from './behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { AgentNode } from '../nodes/agent.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { Inverter } from '../decorators/inverter.js';
import { Retry } from '../decorators/retry.js';
import { NodeStatus } from '../types.js';
import { TestAgent } from '../agent/test-agent.js';

const stubAgent = new TestAgent({ name: 'stub' });

describe('computeContentHash', () => {
  it('produces deterministic output', () => {
    const a = computeContentHash('ActionNode', 'test');
    const b = computeContentHash('ActionNode', 'test');
    expect(a).toBe(b);
  });

  it('produces different hashes for different inputs', () => {
    const a = computeContentHash('ActionNode', 'foo');
    const b = computeContentHash('ActionNode', 'bar');
    expect(a).not.toBe(b);
  });

  it('returns a 16-character hex string', () => {
    const hash = computeContentHash('test');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('node contentHash', () => {
  it('ActionNode produces stable hash across instances', () => {
    const a = new ActionNode({ name: 'test', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ name: 'test', action: async () => NodeStatus.FAILURE });
    expect(a.contentHash()).toBe(b.contentHash());
  });

  it('ActionNode produces different hash for different names', () => {
    const a = new ActionNode({ name: 'foo', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ name: 'bar', action: async () => NodeStatus.SUCCESS });
    expect(a.contentHash()).not.toBe(b.contentHash());
  });

  it('ConditionNode produces stable hash across instances', () => {
    const a = new ConditionNode({ name: 'check', condition: () => true });
    const b = new ConditionNode({ name: 'check', condition: () => false });
    expect(a.contentHash()).toBe(b.contentHash());
  });

  it('AgentNode includes prompt in hash', () => {
    const a = new AgentNode<unknown>({ name: 'agent', agent: stubAgent, prompt: 'Do X' });
    const b = new AgentNode<unknown>({ name: 'agent', agent: stubAgent, prompt: 'Do Y' });
    expect(a.contentHash()).not.toBe(b.contentHash());
  });

  it('contentHash is cached after first call', () => {
    const node = new ActionNode({ name: 'test', action: async () => NodeStatus.SUCCESS });
    const first = node.contentHash();
    const second = node.contentHash();
    expect(first).toBe(second);
  });
});

describe('composite contentHash', () => {
  it('sequence hash includes children order', () => {
    const a = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ name: 'b', action: async () => NodeStatus.SUCCESS });
    const seq1 = new SequenceNode({ name: 'seq', children: [a, b] });
    const seq2 = new SequenceNode({ name: 'seq', children: [b, a] });
    expect(seq1.contentHash()).not.toBe(seq2.contentHash());
  });

  it('same structure produces same hash', () => {
    const make = () => new SequenceNode({
      name: 'seq',
      children: [
        new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS }),
        new ActionNode({ name: 'b', action: async () => NodeStatus.SUCCESS }),
      ],
    });
    expect(make().contentHash()).toBe(make().contentHash());
  });

  it('selector produces different hash from sequence with same children', () => {
    const children = () => [
      new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS }),
    ];
    const seq = new SequenceNode({ name: 's', children: children() });
    const sel = new SelectorNode({ name: 's', children: children() });
    expect(seq.contentHash()).not.toBe(sel.contentHash());
  });

  it('changing a leaf changes the root hash', () => {
    const makeTree = (prompt: string) => new BehaviorTree({
      name: 'test',
      root: new SequenceNode({
        name: 'seq',
        children: [new AgentNode<unknown>({ name: 'agent', agent: stubAgent, prompt })],
      }),
    });
    expect(makeTree('Do X').rootHash).not.toBe(makeTree('Do Y').rootHash);
  });
});

describe('decorator contentHash', () => {
  it('includes config in hash (Retry maxAttempts)', () => {
    const child = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const r3 = new Retry({ name: 'r', child, maxAttempts: 3 });
    const r5 = new Retry({ name: 'r', child, maxAttempts: 5 });
    expect(r3.contentHash()).not.toBe(r5.contentHash());
  });

  it('includes child in hash', () => {
    const a = new ActionNode({ name: 'a', action: async () => NodeStatus.SUCCESS });
    const b = new ActionNode({ name: 'b', action: async () => NodeStatus.SUCCESS });
    const inv1 = new Inverter({ name: 'inv', child: a });
    const inv2 = new Inverter({ name: 'inv', child: b });
    expect(inv1.contentHash()).not.toBe(inv2.contentHash());
  });
});
