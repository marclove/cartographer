import { describe, it, expect } from 'vitest';
import { computeContentHash } from './content-hash.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { AgentNode } from '../nodes/agent.js';
import { NodeStatus } from '../types.js';

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
    const a = new AgentNode({ name: 'agent', prompt: 'Do X' });
    const b = new AgentNode({ name: 'agent', prompt: 'Do Y' });
    expect(a.contentHash()).not.toBe(b.contentHash());
  });

  it('contentHash is cached after first call', () => {
    const node = new ActionNode({ name: 'test', action: async () => NodeStatus.SUCCESS });
    const first = node.contentHash();
    const second = node.contentHash();
    expect(first).toBe(second);
  });
});
