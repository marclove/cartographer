import { describe, it, expect } from 'vitest';
import { TreeRegistry } from './registry.js';
import { NodeStatus } from '../types.js';
import { DefaultSelectionStrategy } from '../strategies/default-selection.js';

describe('TreeRegistry', () => {
  it('registers and retrieves actions', () => {
    const registry = new TreeRegistry();
    const fn = () => NodeStatus.SUCCESS;
    registry.registerAction('actions.doWork', fn);
    expect(registry.getAction('actions.doWork')).toBe(fn);
  });

  it('registers and retrieves conditions', () => {
    const registry = new TreeRegistry();
    const fn = () => true;
    registry.registerCondition('conditions.isReady', fn);
    expect(registry.getCondition('conditions.isReady')).toBe(fn);
  });

  it('registers and retrieves strategies', () => {
    const registry = new TreeRegistry();
    const strategy = new DefaultSelectionStrategy();
    registry.registerStrategy('default-sel', strategy);
    expect(registry.getStrategy('default-sel')).toBe(strategy);
  });

  it('throws on missing action', () => {
    const registry = new TreeRegistry();
    expect(() => registry.getAction('missing')).toThrow('Action "missing" not found');
  });

  it('throws on missing condition', () => {
    const registry = new TreeRegistry();
    expect(() => registry.getCondition('missing')).toThrow('Condition "missing" not found');
  });

  it('throws on missing strategy', () => {
    const registry = new TreeRegistry();
    expect(() => registry.getStrategy('missing')).toThrow('Strategy "missing" not found');
  });
});
