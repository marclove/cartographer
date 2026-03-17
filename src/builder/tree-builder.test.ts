import { describe, it, expect, vi } from 'vitest';
import { TreeBuilder } from './tree-builder.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { AgentSelectionStrategy } from '../strategies/agent-selection.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';
import { TreeRegistry } from '../config/registry.js';
import { DefaultExecutionStrategy } from '../strategies/default-execution.js';

const flush = () => new Promise(r => setTimeout(r, 0));

describe('TreeBuilder', () => {
  it('builds a tree with a single action node', async () => {
    const tree = new TreeBuilder('simple')
      .action('root', () => NodeStatus.SUCCESS)
      .build();
    expect(tree.name).toBe('simple');
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('builds a selector with children', async () => {
    const tree = new TreeBuilder('sel-tree')
      .selector('root', (s) =>
        s
          .action('fail', () => NodeStatus.FAILURE)
          .action('succeed', () => NodeStatus.SUCCESS)
      )
      .build();
    // Tick 1: fail starts inflight → RUNNING
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    // Tick 2: fail FAILURE (cached), succeed starts inflight → RUNNING
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    // Tick 3: fail cached, succeed SUCCESS → SUCCESS
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('builds a sequence with children', async () => {
    const tree = new TreeBuilder('seq-tree')
      .sequence('root', (s) =>
        s
          .action('first', () => NodeStatus.SUCCESS)
          .action('second', () => NodeStatus.SUCCESS)
      )
      .build();
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('builds a sequence that fails on first failure', async () => {
    const tree = new TreeBuilder('seq-tree')
      .sequence('root', (s) =>
        s
          .action('first', () => NodeStatus.FAILURE)
          .action('second', () => NodeStatus.SUCCESS)
      )
      .build();
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.FAILURE);
  });

  it('builds nested composites', async () => {
    const tree = new TreeBuilder('nested')
      .selector('root', (s) =>
        s
          .sequence('check-and-act', (seq) =>
            seq
              .condition('check', () => true)
              .action('act', () => NodeStatus.SUCCESS)
          )
          .action('fallback', () => NodeStatus.FAILURE)
      )
      .build();
    // Tick 1: selector → sequence → condition SUCCESS, act starts inflight → RUNNING
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    // Tick 2: selector → sequence → condition SUCCESS (reactive), act SUCCESS → SUCCESS
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('supports condition nodes', async () => {
    const tree = new TreeBuilder('cond-tree')
      .sequence('root', (s) =>
        s
          .condition('is-ready', () => false)
          .action('do-work', () => NodeStatus.SUCCESS)
      )
      .build();
    expect(await tree.tick()).toBe(NodeStatus.FAILURE);
  });

  it('supports parallel nodes', async () => {
    const tree = new TreeBuilder('par-tree')
      .parallel('root', { strategy: new DefaultParallelStrategy({ successCount: 1 }) }, (p) =>
        p
          .action('a', () => NodeStatus.FAILURE)
          .action('b', () => NodeStatus.SUCCESS)
      )
      .build();
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('supports strategy on selector', async () => {
    const tree = new TreeBuilder('strat-tree')
      .selector('root', { strategy: new AgentSelectionStrategy({ prompt: 'test' }) }, (s) =>
        s.action('only', () => NodeStatus.SUCCESS)
      )
      .build();
    expect(tree).toBeDefined();
  });

  it('supports agent nodes in the builder', () => {
    const tree = new TreeBuilder('agent-tree')
      .sequence('root', (s) =>
        s
          .condition('check', () => true)
          .agent('classify', {
            prompt: 'Classify this',
          })
      )
      .build();
    expect(tree).toBeDefined();
  });

  it('supports decorator nodes', async () => {
    const tree = new TreeBuilder('dec-tree')
      .inverter('root',
        (b) => b.action('child', () => NodeStatus.SUCCESS)
      )
      .build();
    // Tick 1: action starts inflight → inverter sees RUNNING → RUNNING
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    // Tick 2: action completes SUCCESS → inverter returns FAILURE
    expect(await tree.tick()).toBe(NodeStatus.FAILURE);
  });

  it('supports retry decorator', async () => {
    let attempts = 0;
    const tree = new TreeBuilder('retry-tree')
      .retry('root', { maxAttempts: 3 },
        (b) => b.action('flaky', () => {
          attempts++;
          return attempts >= 3 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
        })
      )
      .build();
    // Each attempt needs: tick (starts inflight → RUNNING) → flush → tick (completes)
    // Attempt 1: FAILURE → retry
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.RUNNING); // retry sees FAILURE, starts attempt 2
    await flush();
    // Attempt 2: FAILURE → retry
    expect(await tree.tick()).toBe(NodeStatus.RUNNING); // retry sees FAILURE, starts attempt 3
    await flush();
    // Attempt 3: SUCCESS
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
    expect(attempts).toBe(3);
  });

  it('blackboard is accessible in actions', async () => {
    const tree = new TreeBuilder('bb-tree')
      .sequence('root', (s) =>
        s
          .action('write', (ctx) => {
            ctx.blackboard.set('msg', 'hello');
            return NodeStatus.SUCCESS;
          })
          .condition('read', (ctx) => ctx.blackboard.get('msg') === 'hello')
      )
      .build();
    // Tick 1: write starts inflight → RUNNING
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    // Tick 2: write completes (cached), condition reads 'hello' → SUCCESS
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  describe('onElicitation', () => {
    it('passes onElicitation to BehaviorTreeConfig via build()', async () => {
      const handler = vi.fn();

      const tree = new TreeBuilder('test')
        .onElicitation(handler)
        .action('a', (ctx) => {
          expect(ctx.onElicitation).toBe(handler);
          return NodeStatus.SUCCESS;
        })
        .build();

      await tree.tick(); // action runs in inflight, assertion inside action
    });
  });

  describe('context overrides on composites', () => {
    it('sets contextOverrides on a sequence node via CompositeBuilder', async () => {
      const handler = vi.fn();
      let receivedCtx: TreeContext | undefined;
      const tree = new TreeBuilder('test')
        .sequence('seq', { context: { onElicitation: handler } }, (b) => {
          b.action('a', (ctx) => { receivedCtx = ctx; return NodeStatus.SUCCESS; });
        })
        .build();

      await tree.tick();
      expect(receivedCtx!.onElicitation).toBe(handler);
    });

    it('sets contextOverrides on a selector node via CompositeBuilder', async () => {
      const handler = vi.fn();
      let receivedCtx: TreeContext | undefined;
      const tree = new TreeBuilder('test')
        .selector('sel', { context: { onElicitation: handler } }, (b) => {
          b.action('a', (ctx) => { receivedCtx = ctx; return NodeStatus.SUCCESS; });
        })
        .build();

      await tree.tick();
      expect(receivedCtx!.onElicitation).toBe(handler);
    });

    it('sets contextOverrides on a parallel node via CompositeBuilder', async () => {
      const handler = vi.fn();
      let receivedCtx: TreeContext | undefined;
      const tree = new TreeBuilder('test')
        .parallel('par', { context: { onElicitation: handler } }, (b) => {
          b.action('a', (ctx) => { receivedCtx = ctx; return NodeStatus.SUCCESS; });
        })
        .build();

      await tree.tick();
      expect(receivedCtx!.onElicitation).toBe(handler);
    });
  });

  describe('context overrides on decorators', () => {
    it('sets contextOverrides on a retry node', async () => {
      const handler = vi.fn();
      let receivedCtx: TreeContext | undefined;
      const tree = new TreeBuilder('test')
        .retry('r', { maxAttempts: 2, context: { onElicitation: handler } }, (b) => {
          b.action('a', (ctx) => { receivedCtx = ctx; return NodeStatus.SUCCESS; });
        })
        .build();

      await tree.tick();
      expect(receivedCtx!.onElicitation).toBe(handler);
    });

    it('sets contextOverrides on a repeat node', async () => {
      const handler = vi.fn();
      let receivedCtx: TreeContext | undefined;
      const tree = new TreeBuilder('test')
        .repeat('rep', { count: 1, context: { onElicitation: handler } }, (b) => {
          b.action('a', (ctx) => { receivedCtx = ctx; return NodeStatus.SUCCESS; });
        })
        .build();

      await tree.tick();
      expect(receivedCtx!.onElicitation).toBe(handler);
    });

    it('sets contextOverrides on a timeout node', async () => {
      const handler = vi.fn();
      let receivedCtx: TreeContext | undefined;
      const tree = new TreeBuilder('test')
        .timeout('t', { timeoutMs: 1000, context: { onElicitation: handler } }, (b) => {
          b.action('a', (ctx) => { receivedCtx = ctx; return NodeStatus.SUCCESS; });
        })
        .build();

      await tree.tick();
      expect(receivedCtx!.onElicitation).toBe(handler);
    });

    it('sets contextOverrides on a guard node', async () => {
      const handler = vi.fn();
      let receivedCtx: TreeContext | undefined;
      const tree = new TreeBuilder('test')
        .guard('g', { condition: () => true, context: { onElicitation: handler } }, (b) => {
          b.action('a', (ctx) => { receivedCtx = ctx; return NodeStatus.SUCCESS; });
        })
        .build();

      await tree.tick();
      expect(receivedCtx!.onElicitation).toBe(handler);
    });
  });

  describe('context overrides via SingleChildBuilder', () => {
    it('sets contextOverrides on a nested sequence inside a decorator', async () => {
      const handler = vi.fn();
      let receivedCtx: TreeContext | undefined;
      const tree = new TreeBuilder('test')
        .retry('r', { maxAttempts: 2 }, (b) => {
          b.sequence('seq', { context: { onElicitation: handler } }, (b) => {
            b.action('a', (ctx) => { receivedCtx = ctx; return NodeStatus.SUCCESS; });
          });
        })
        .build();

      await tree.tick();
      expect(receivedCtx!.onElicitation).toBe(handler);
    });
  });
});

describe('registry integration', () => {
  const flush = () => new Promise(r => setTimeout(r, 0));

  function makeRegistry() {
    const registry = new TreeRegistry();
    registry.registerAction('succeed', () => NodeStatus.SUCCESS);
    registry.registerAction('write-result', (ctx) => {
      ctx.blackboard.set('result', 'done');
      return NodeStatus.SUCCESS;
    });
    registry.registerCondition('always-true', () => true);
    registry.registerCondition('always-false', () => false);
    registry.registerStrategy('exec-strategy', new DefaultExecutionStrategy());
    return registry;
  }

  it('resolves action from registry', async () => {
    const registry = makeRegistry();
    const tree = new TreeBuilder('test', registry)
      .action('root', 'succeed')
      .build();
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('resolves condition from registry', async () => {
    const registry = makeRegistry();
    const tree = new TreeBuilder('test', registry)
      .condition('root', 'always-true')
      .build();
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('resolves strategy from registry on sequence', async () => {
    const registry = makeRegistry();
    const tree = new TreeBuilder('test', registry)
      .sequence('root', { strategy: 'exec-strategy' }, (b) => {
        b.action('step', 'succeed');
      })
      .build();
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('resolves strategy from registry on selector', async () => {
    const registry = makeRegistry();
    const tree = new TreeBuilder('test', registry)
      .selector('root', { strategy: 'exec-strategy' }, (b) => {
        b.action('step', 'succeed');
      })
      .build();
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('resolves strategy from registry on parallel', async () => {
    const registry = makeRegistry();
    registry.registerStrategy('par-strategy', new DefaultParallelStrategy({ successCount: 1 }));
    const tree = new TreeBuilder('test', registry)
      .parallel('root', { strategy: 'par-strategy' }, (b) => {
        b.action('step', 'succeed');
      })
      .build();
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('resolves guard condition from registry', async () => {
    const registry = makeRegistry();
    const tree = new TreeBuilder('test', registry)
      .guard('root', { condition: 'always-true' }, (b) => {
        b.action('child', 'succeed');
      })
      .build();
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('mixes inline and registry refs in same composite', async () => {
    const registry = makeRegistry();
    const tree = new TreeBuilder('test', registry)
      .sequence('root', (b) => {
        b.condition('check', 'always-true');
        b.action('step', () => NodeStatus.SUCCESS);
      })
      .build();
    // condition resolves immediately; inline action goes through inflight
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('resolves refs in SingleChildBuilder context (inside decorator)', async () => {
    const registry = makeRegistry();
    const tree = new TreeBuilder('test', registry)
      .retry('root', { maxAttempts: 2 }, (b) => {
        b.action('child', 'succeed');
      })
      .build();
    expect(await tree.tick()).toBe(NodeStatus.RUNNING);
    await flush();
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('resolves deeply nested ref (guard condition inside inverter inside sequence)', async () => {
    const registry = makeRegistry();
    const tree = new TreeBuilder('test', registry)
      .sequence('root', (b) => {
        b.inverter('inv', (b) => {
          b.guard('gate', { condition: 'always-false' }, (b) => {
            b.action('never-reached', 'succeed');
          });
        });
      })
      .build();
    // guard condition is false → FAILURE, inverter flips to SUCCESS
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('throws when using string ref without a registry', () => {
    expect(() => {
      new TreeBuilder('test')
        .action('root', 'some-ref')
        .build();
    }).toThrow('Cannot resolve registry reference "some-ref": no registry provided to TreeBuilder');
  });

  it('throws when registry key does not exist', () => {
    const registry = makeRegistry();
    expect(() => {
      new TreeBuilder('test', registry)
        .action('root', 'nonexistent')
        .build();
    }).toThrow('Action "nonexistent" not found in registry');
  });
});
