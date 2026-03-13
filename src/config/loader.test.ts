import { describe, it, expect } from 'vitest';
import { TreeLoader } from './loader.js';
import { TreeRegistry } from './registry.js';
import { NodeStatus } from '../types.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';

const flush = () => new Promise(r => setTimeout(r, 0));

describe('TreeLoader', () => {
  it('loads a simple action tree from config object', async () => {
    const registry = new TreeRegistry();
    registry.registerAction('actions.greet', () => NodeStatus.SUCCESS);

    const config = {
      name: 'simple',
      root: {
        type: 'action',
        name: 'greet',
        ref: 'actions.greet',
      },
    };

    const tree = TreeLoader.fromConfig(config, registry);
    expect(tree.name).toBe('simple');
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('loads a selector with children', async () => {
    const registry = new TreeRegistry();
    registry.registerAction('actions.fail', () => NodeStatus.FAILURE);
    registry.registerAction('actions.succeed', () => NodeStatus.SUCCESS);

    const config = {
      name: 'selector-tree',
      root: {
        type: 'selector',
        name: 'root',
        children: [
          { type: 'action', name: 'fail', ref: 'actions.fail' },
          { type: 'action', name: 'succeed', ref: 'actions.succeed' },
        ],
      },
    };

    const tree = TreeLoader.fromConfig(config, registry);
    // Selector: fail starts inflight → RUNNING
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    // fail FAILURE (cached), succeed starts → RUNNING
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    // succeed SUCCESS → SUCCESS
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('loads a sequence with conditions', async () => {
    const registry = new TreeRegistry();
    registry.registerCondition('conditions.isTrue', () => true);
    registry.registerAction('actions.work', () => NodeStatus.SUCCESS);

    const config = {
      name: 'seq-tree',
      root: {
        type: 'sequence',
        name: 'root',
        children: [
          { type: 'condition', name: 'check', ref: 'conditions.isTrue' },
          { type: 'action', name: 'work', ref: 'actions.work' },
        ],
      },
    };

    const tree = TreeLoader.fromConfig(config, registry);
    // Sequence: condition SUCCESS, action starts inflight → RUNNING
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    // Condition re-ticked (SUCCESS), action completes → SUCCESS
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('loads a parallel node with strategy ref', async () => {
    const registry = new TreeRegistry();
    registry.registerAction('actions.a', () => NodeStatus.SUCCESS);
    registry.registerAction('actions.b', () => NodeStatus.FAILURE);
    registry.registerStrategy('par-one', new DefaultParallelStrategy({ successCount: 1 }));

    const config = {
      name: 'par-tree',
      root: {
        type: 'parallel',
        name: 'root',
        strategy: { ref: 'par-one' },
        children: [
          { type: 'action', name: 'a', ref: 'actions.a' },
          { type: 'action', name: 'b', ref: 'actions.b' },
        ],
      },
    };

    const tree = TreeLoader.fromConfig(config, registry);
    // Parallel: both start inflight → RUNNING
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    // a SUCCESS, b FAILURE → policy successCount:1 → SUCCESS
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('loads agent nodes with inline config', async () => {
    const registry = new TreeRegistry();

    const config = {
      name: 'agent-tree',
      root: {
        type: 'agent',
        name: 'classify',
        prompt: 'Classify this input',
        blackboardNamespace: 'classify',
        cache: true,
        options: {
          model: 'claude-haiku-4-5-20251001',
          effort: 'low',
        },
      },
    };

    const tree = TreeLoader.fromConfig(config, registry);
    expect(tree).toBeDefined();
  });

  it('loads decorator nodes', async () => {
    const registry = new TreeRegistry();
    registry.registerAction('actions.work', () => NodeStatus.SUCCESS);

    const config = {
      name: 'dec-tree',
      root: {
        type: 'inverter',
        name: 'inv',
        child: { type: 'action', name: 'work', ref: 'actions.work' },
      },
    };

    const tree = TreeLoader.fromConfig(config, registry);
    // Inverter wraps action: action starts inflight → inverter sees RUNNING → RUNNING
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    // Action completes SUCCESS → inverter returns FAILURE
    expect(await tree.tick()).toBe(NodeStatus.FAILURE);
  });

  it('loads retry decorator with options', async () => {
    const registry = new TreeRegistry();
    let count = 0;
    registry.registerAction('actions.flaky', () => {
      count++;
      return count >= 2 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
    });

    const config = {
      name: 'retry-tree',
      root: {
        type: 'retry',
        name: 'retrier',
        maxAttempts: 3,
        child: { type: 'action', name: 'flaky', ref: 'actions.flaky' },
      },
    };

    const tree = TreeLoader.fromConfig(config, registry);
    // Attempt 1: action starts inflight → RUNNING
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    // Attempt 1: action FAILURE → retry starts attempt 2 inflight → RUNNING
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    // Attempt 2: action SUCCESS → SUCCESS
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('loads from YAML string', async () => {
    const registry = new TreeRegistry();
    registry.registerAction('actions.hello', () => NodeStatus.SUCCESS);

    const yaml = `
name: yaml-tree
root:
  type: action
  name: hello
  ref: actions.hello
`;

    const tree = TreeLoader.fromYAML(yaml, registry);
    expect(tree.name).toBe('yaml-tree');
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('passes id from config to node', async () => {
    const registry = new TreeRegistry();
    registry.registerAction('noop', async () => NodeStatus.SUCCESS);
    const tree = TreeLoader.fromConfig({
      name: 'test',
      root: { type: 'action', name: 'act', ref: 'noop', id: 'custom-id' },
    }, registry);
    expect(tree).toBeDefined();
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('throws on unknown node type', () => {
    const registry = new TreeRegistry();

    const config = {
      name: 'bad-tree',
      root: { type: 'unknown', name: 'bad' },
    };

    expect(() => TreeLoader.fromConfig(config, registry)).toThrow('Unknown node type: unknown');
  });
});
