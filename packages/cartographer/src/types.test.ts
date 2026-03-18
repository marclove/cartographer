import { describe, it, expect } from 'vitest';
import { NodeStatus } from './types.js';

describe('NodeStatus', () => {
  it('has SUCCESS, FAILURE, and RUNNING values', () => {
    expect(NodeStatus.SUCCESS).toBe('success');
    expect(NodeStatus.FAILURE).toBe('failure');
    expect(NodeStatus.RUNNING).toBe('running');
  });
});
