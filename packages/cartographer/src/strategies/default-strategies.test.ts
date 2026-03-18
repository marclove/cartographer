import { describe, it, expect } from 'vitest';
import { DefaultSelectionStrategy } from './default-selection.js';
import { DefaultExecutionStrategy } from './default-execution.js';
import { DefaultParallelStrategy } from './default-parallel.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

function mockNode(name: string): BTreeNode {
  return {
    id: name,
    name,
    tick: async () => NodeStatus.SUCCESS,
    reset: () => {},
    abort: () => {},
  };
}

describe('DefaultSelectionStrategy', () => {
  it('returns children in original order', async () => {
    const strategy = new DefaultSelectionStrategy();
    const children = [mockNode('a'), mockNode('b'), mockNode('c')];
    const result = await strategy.order(children, createContext());
    expect(result.map((n) => n.name)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array for no children', async () => {
    const strategy = new DefaultSelectionStrategy();
    const result = await strategy.order([], createContext());
    expect(result).toEqual([]);
  });
});

describe('DefaultExecutionStrategy', () => {
  it('returns children in original order', async () => {
    const strategy = new DefaultExecutionStrategy();
    const children = [mockNode('x'), mockNode('y')];
    const result = await strategy.order(children, createContext());
    expect(result.map((n) => n.name)).toEqual(['x', 'y']);
  });
});

describe('DefaultParallelStrategy', () => {
  it('returns the configured policy', async () => {
    const strategy = new DefaultParallelStrategy({ successCount: 2 });
    const result = await strategy.policy([mockNode('a'), mockNode('b')], createContext());
    expect(result).toEqual({ successCount: 2 });
  });

  it('defaults to requiring all children to succeed', async () => {
    const children = [mockNode('a'), mockNode('b'), mockNode('c')];
    const strategy = new DefaultParallelStrategy();
    const result = await strategy.policy(children, createContext());
    expect(result).toEqual({ successCount: 3 });
  });

  it('supports successPercentage', async () => {
    const strategy = new DefaultParallelStrategy({ successPercentage: 50 });
    const result = await strategy.policy([], createContext());
    expect(result).toEqual({ successPercentage: 50 });
  });

  it('supports failureCount', async () => {
    const strategy = new DefaultParallelStrategy({ failureCount: 1 });
    const result = await strategy.policy([], createContext());
    expect(result).toEqual({ failureCount: 1 });
  });
});
