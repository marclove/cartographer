import { describe, it, expect } from 'vitest';
import { NodeStatus } from '../types.js';
import { AbortTrackingNode, countingAction, createContext, setupTest } from './helpers.js';
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';

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

describe('setupTest', () => {
  it('boots server on ephemeral port and connects client', async () => {
    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'test',
          root: new ActionNode({
            name: 'noop',
            action: () => NodeStatus.SUCCESS,
          }),
        }),
    });

    expect(harness.port).toBeGreaterThan(0);
    expect(harness.server).toBeDefined();
    expect(harness.client).toBeDefined();

    // Client SSE is connected — actionAndWait should work without hanging
    const result = await harness.client.actionAndWait('tick');
    expect(result.treeStatus).toBe('success');
  });

  it('teardown stops server and disconnects client', async () => {
    const harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'test',
          root: new ActionNode({
            name: 'noop',
            action: () => NodeStatus.SUCCESS,
          }),
        }),
    });

    await harness.teardown();

    // Server is stopped — fetch should fail
    await expect(
      fetch(`http://localhost:${harness.port}/_platform/health`),
    ).rejects.toThrow();
  });

  it('passes options through to ActorServer', async () => {
    await using harness = await setupTest({
      createTree: () =>
        new BehaviorTree({
          name: 'test',
          root: new ActionNode({
            name: 'read-ctx',
            action: (ctx) => {
              ctx.blackboard.set('result', ctx.blackboard.get('context:tenant'));
              return NodeStatus.SUCCESS;
            },
          }),
        }),
      context: { tenant: 'test-tenant' },
    });

    await harness.client.actionAndWait('tick');
    const bb = await harness.client.blackboard();
    expect(bb['result']).toBe('test-tenant');
  });
});
