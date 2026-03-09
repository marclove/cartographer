import { describe, it, expect } from 'vitest';
import { NodeStatus } from '../types.js';
import { AbortTrackingNode, countingAction, createContext } from './helpers.js';

describe('AbortTrackingNode', () => {
  it('returns configured status and tracks abort', async () => {
    const node = new AbortTrackingNode('test');
    const ctx = createContext();

    expect(node.aborted).toBe(false);
    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);

    node.abort();
    expect(node.aborted).toBe(true);
  });

  it('returns custom status', async () => {
    const node = new AbortTrackingNode('test', NodeStatus.SUCCESS);
    const ctx = createContext();
    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.SUCCESS);
  });
});

describe('countingAction', () => {
  it('tracks tick count and follows status sequence', () => {
    const { config, getTicks } = countingAction('test', [
      NodeStatus.RUNNING,
      NodeStatus.SUCCESS,
    ]);

    expect(getTicks()).toBe(0);
    config.action(createContext());
    expect(getTicks()).toBe(1);
    config.action(createContext());
    expect(getTicks()).toBe(2);
  });

  it('repeats last status when sequence exhausted', () => {
    const { config, getTicks } = countingAction('test', [NodeStatus.FAILURE]);
    expect(config.action(createContext())).toBe(NodeStatus.FAILURE);
    expect(config.action(createContext())).toBe(NodeStatus.FAILURE);
    expect(getTicks()).toBe(2);
  });
});
