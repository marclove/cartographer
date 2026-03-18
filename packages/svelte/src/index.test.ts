import { describe, it, expect } from 'vitest';
import * as pkg from './index.js';

describe('@cartographer/svelte exports', () => {
  it('exports Cartographer component', () => {
    expect(pkg.Cartographer).toBeDefined();
  });

  it('exports getClient', () => {
    expect(typeof pkg.getClient).toBe('function');
  });

  it('exports blackboard functions', () => {
    expect(typeof pkg.getBlackboard).toBe('function');
    expect(typeof pkg.getBlackboardSnapshot).toBe('function');
  });

  it('exports status functions', () => {
    expect(typeof pkg.getConnectionStatus).toBe('function');
    expect(typeof pkg.getTreeStatus).toBe('function');
  });

  it('exports createAction', () => {
    expect(typeof pkg.createAction).toBe('function');
  });

  it('exports event subscription functions', () => {
    expect(typeof pkg.onClientEvent).toBe('function');
    expect(typeof pkg.onTreeEvent).toBe('function');
  });

  it('exports createMockClient', () => {
    expect(typeof pkg.createMockClient).toBe('function');
  });
});
