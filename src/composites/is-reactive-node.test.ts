import { describe, it, expect } from 'vitest';
import { isReactiveNode } from './is-reactive-node.js';
import { ConditionNode } from '../nodes/condition.js';
import { ActionNode } from '../nodes/action.js';
import { InverterNode } from '../decorators/inverter.js';
import { AlwaysSucceedNode } from '../decorators/always-succeed.js';
import { GuardNode } from '../decorators/guard.js';
import { SequenceNode } from './sequence.js';
import { SelectorNode } from './selector.js';
import { NodeStatus } from '../types.js';

const cond = new ConditionNode({ name: 'cond', condition: () => true });
const action = new ActionNode({
  name: 'action',
  action: async () => NodeStatus.SUCCESS,
});

describe('isReactiveNode', () => {
  it('returns true for a ConditionNode', () => {
    expect(isReactiveNode(cond)).toBe(true);
  });

  it('returns false for an ActionNode', () => {
    expect(isReactiveNode(action)).toBe(false);
  });

  it('returns false for a SequenceNode', () => {
    const seq = new SequenceNode({ name: 'seq', children: [cond, action] });
    expect(isReactiveNode(seq)).toBe(false);
  });

  it('returns false for a SelectorNode', () => {
    const sel = new SelectorNode({ name: 'sel', children: [cond, action] });
    expect(isReactiveNode(sel)).toBe(false);
  });

  it('returns true for Inverter wrapping a ConditionNode', () => {
    const inv = new InverterNode({ name: 'inv', child: cond });
    expect(isReactiveNode(inv)).toBe(true);
  });

  it('returns false for Inverter wrapping an ActionNode', () => {
    const inv = new InverterNode({ name: 'inv', child: action });
    expect(isReactiveNode(inv)).toBe(false);
  });

  it('returns true for nested decorators with ConditionNode at leaf', () => {
    const inner = new InverterNode({ name: 'inv', child: cond });
    const outer = new AlwaysSucceedNode({ name: 'as', child: inner });
    expect(isReactiveNode(outer)).toBe(true);
  });

  it('returns false for nested decorators with ActionNode at leaf', () => {
    const inner = new InverterNode({ name: 'inv', child: action });
    const outer = new AlwaysSucceedNode({ name: 'as', child: inner });
    expect(isReactiveNode(outer)).toBe(false);
  });

  it('returns true for GuardNode wrapping a ConditionNode', () => {
    const guard = new GuardNode({
      name: 'guard',
      child: cond,
      condition: () => true,
    });
    expect(isReactiveNode(guard)).toBe(true);
  });
});
