import { describe, it, expect } from 'vitest';
import { validateSessionConcurrency } from './session-validation.js';
import { AgentNode } from '../nodes/agent.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { ParallelNode } from '../composites/parallel.js';
import { ActionNode } from '../nodes/action.js';
import { TestAgent } from '../agent/test-agent.js';
import { NodeStatus } from '../types.js';

function makeAgentNode(name: string, session?: string | { name: string; fork?: true | string }): AgentNode {
  return new AgentNode({
    name,
    agent: new TestAgent({ name }),
    prompt: 'test',
    session,
  });
}

describe('validateSessionConcurrency', () => {
  it('allows two resume-mode agents on the same session in a SequenceNode', () => {
    const root = new SequenceNode({
      name: 'seq',
      children: [
        makeAgentNode('a', 'triage'),
        makeAgentNode('b', 'triage'),
      ],
    });
    expect(() => validateSessionConcurrency(root)).not.toThrow();
  });

  it('allows two resume-mode agents on the same session in a SelectorNode', () => {
    const root = new SelectorNode({
      name: 'sel',
      children: [
        makeAgentNode('a', 'triage'),
        makeAgentNode('b', 'triage'),
      ],
    });
    expect(() => validateSessionConcurrency(root)).not.toThrow();
  });

  it('throws when two resume-mode agents on the same session are in different branches of a ParallelNode', () => {
    const root = new ParallelNode({
      name: 'par',
      children: [
        makeAgentNode('a', 'triage'),
        makeAgentNode('b', 'triage'),
      ],
    });
    expect(() => validateSessionConcurrency(root)).toThrow(/session.*"triage".*ParallelNode/i);
  });

  it('allows fork-mode agents on the same session in a ParallelNode', () => {
    const root = new ParallelNode({
      name: 'par',
      children: [
        makeAgentNode('a', { name: 'triage', fork: true }),
        makeAgentNode('b', { name: 'triage', fork: true }),
      ],
    });
    expect(() => validateSessionConcurrency(root)).not.toThrow();
  });

  it('allows named fork agents on the same session in a ParallelNode', () => {
    const root = new ParallelNode({
      name: 'par',
      children: [
        makeAgentNode('a', { name: 'triage', fork: 'a-thread' }),
        makeAgentNode('b', { name: 'triage', fork: 'b-thread' }),
      ],
    });
    expect(() => validateSessionConcurrency(root)).not.toThrow();
  });

  it('allows one resume and one fork on the same session in a ParallelNode', () => {
    const root = new ParallelNode({
      name: 'par',
      children: [
        makeAgentNode('a', 'triage'),
        makeAgentNode('b', { name: 'triage', fork: true }),
      ],
    });
    expect(() => validateSessionConcurrency(root)).not.toThrow();
  });

  it('throws for resume conflicts in deeply nested parallel branches', () => {
    const root = new ParallelNode({
      name: 'par',
      children: [
        new SequenceNode({
          name: 'branch-a',
          children: [makeAgentNode('a1', 'triage')],
        }),
        new SequenceNode({
          name: 'branch-b',
          children: [makeAgentNode('b1', 'triage')],
        }),
      ],
    });
    expect(() => validateSessionConcurrency(root)).toThrow(/session.*"triage".*ParallelNode/i);
  });

  it('allows different session names in parallel branches', () => {
    const root = new ParallelNode({
      name: 'par',
      children: [
        makeAgentNode('a', 'session-a'),
        makeAgentNode('b', 'session-b'),
      ],
    });
    expect(() => validateSessionConcurrency(root)).not.toThrow();
  });

  it('validates nested ParallelNodes independently', () => {
    const root = new SequenceNode({
      name: 'seq',
      children: [
        new ParallelNode({
          name: 'par-1',
          children: [
            makeAgentNode('a', 'alpha'),
            makeAgentNode('b', 'beta'),
          ],
        }),
        new ParallelNode({
          name: 'par-2',
          children: [
            makeAgentNode('c', 'alpha'),
            makeAgentNode('d', 'beta'),
          ],
        }),
      ],
    });
    expect(() => validateSessionConcurrency(root)).not.toThrow();
  });

  it('passes when no agents have session config', () => {
    const root = new SequenceNode({
      name: 'seq',
      children: [
        makeAgentNode('a'),
        new ActionNode({ name: 'action', action: async () => NodeStatus.SUCCESS }),
      ],
    });
    expect(() => validateSessionConcurrency(root)).not.toThrow();
  });
});
