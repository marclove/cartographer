# Task 14: Fluent Builder API

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the fluent builder that lets users compose behavior trees using a nested callback pattern.

**Architecture:** `BehaviorTree.create()` returns a `TreeBuilder`. Each composite method (`.selector()`, `.sequence()`, `.parallel()`) receives a callback that configures children via a `CompositeBuilder`. The builder constructs the actual node tree when `.build()` is called.

**Tech Stack:** TypeScript

---

### Step 1: Write failing tests

Create `src/builder/tree-builder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TreeBuilder } from './tree-builder.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { AgentSelectionStrategy } from '../strategies/agent-selection.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';
import { z } from 'zod';

describe('TreeBuilder', () => {
  it('builds a tree with a single action node', async () => {
    const tree = new TreeBuilder('simple')
      .action('root', () => NodeStatus.SUCCESS)
      .build();

    expect(tree.name).toBe('simple');
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

    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('supports strategy on selector', async () => {
    // Just verify the builder accepts a strategy — actual reordering is tested in strategy tests
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
            mode: 'structured',
            prompt: 'Classify this',
            outputSchema: z.object({ label: z.string() }),
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

    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/builder/tree-builder.test.ts`
Expected: FAIL

### Step 3: Implement TreeBuilder

Create `src/builder/tree-builder.ts`:

```typescript
import { BehaviorTree } from '../core/behavior-tree.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { AgentNode } from '../nodes/agent.js';
import { SelectorNode } from '../composites/selector.js';
import { SequenceNode } from '../composites/sequence.js';
import { ParallelNode } from '../composites/parallel.js';
import { InverterNode } from '../decorators/inverter.js';
import { RepeatNode } from '../decorators/repeat.js';
import { RetryNode } from '../decorators/retry.js';
import { AlwaysSucceedNode } from '../decorators/always-succeed.js';
import { AlwaysFailNode } from '../decorators/always-fail.js';
import { TimeoutNode } from '../decorators/timeout.js';
import { GuardNode } from '../decorators/guard.js';
import { NodeStatus } from '../types.js';
import type {
  BTreeNode, TreeContext, SelectionStrategy, ExecutionStrategy, ParallelStrategy,
  AgentNodeConfig,
} from '../types.js';

type ActionFn = (context: TreeContext) => Promise<NodeStatus> | NodeStatus;
type ConditionFn = (context: TreeContext) => Promise<boolean> | boolean;

export class CompositeBuilder {
  private children: BTreeNode[] = [];

  action(name: string, fn: ActionFn): this {
    this.children.push(new ActionNode({ name, action: fn }));
    return this;
  }

  condition(name: string, fn: ConditionFn): this {
    this.children.push(new ConditionNode({ name, condition: fn }));
    return this;
  }

  agent(name: string, config: Omit<AgentNodeConfig, 'name'>): this {
    this.children.push(new AgentNode({ name, ...config }));
    return this;
  }

  selector(name: string, optionsOrConfigure?: { strategy?: SelectionStrategy } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const builder = new CompositeBuilder();
    configureFn?.(builder);
    this.children.push(new SelectorNode({ name, children: builder.getChildren(), strategy }));
    return this;
  }

  sequence(name: string, optionsOrConfigure?: { strategy?: ExecutionStrategy } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const builder = new CompositeBuilder();
    configureFn?.(builder);
    this.children.push(new SequenceNode({ name, children: builder.getChildren(), strategy }));
    return this;
  }

  parallel(name: string, optionsOrConfigure?: { strategy?: ParallelStrategy } | ((b: CompositeBuilder) => void), configure?: (b: CompositeBuilder) => void): this {
    const { strategy, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
    const builder = new CompositeBuilder();
    configureFn?.(builder);
    this.children.push(new ParallelNode({ name, children: builder.getChildren(), strategy }));
    return this;
  }

  inverter(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new InverterNode({ name, child: builder.getChild() }));
    return this;
  }

  repeat(name: string, options: { count?: number; untilStatus?: NodeStatus }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new RepeatNode({ name, child: builder.getChild(), ...options }));
    return this;
  }

  retry(name: string, options: { maxAttempts: number; delayMs?: number }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new RetryNode({ name, child: builder.getChild(), ...options }));
    return this;
  }

  alwaysSucceed(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new AlwaysSucceedNode({ name, child: builder.getChild() }));
    return this;
  }

  alwaysFail(name: string, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new AlwaysFailNode({ name, child: builder.getChild() }));
    return this;
  }

  timeout(name: string, options: { timeoutMs: number }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new TimeoutNode({ name, child: builder.getChild(), ...options }));
    return this;
  }

  guard(name: string, options: { condition: ConditionFn }, configure: (b: SingleChildBuilder) => void): this {
    const builder = new SingleChildBuilder();
    configure(builder);
    this.children.push(new GuardNode({ name, child: builder.getChild(), condition: options.condition }));
    return this;
  }

  getChildren(): BTreeNode[] {
    return this.children;
  }
}

export class SingleChildBuilder {
  private child: BTreeNode | null = null;

  action(name: string, fn: ActionFn): this {
    this.child = new ActionNode({ name, action: fn });
    return this;
  }

  condition(name: string, fn: ConditionFn): this {
    this.child = new ConditionNode({ name, condition: fn });
    return this;
  }

  agent(name: string, config: Omit<AgentNodeConfig, 'name'>): this {
    this.child = new AgentNode({ name, ...config });
    return this;
  }

  getChild(): BTreeNode {
    if (!this.child) {
      throw new Error('Decorator must have exactly one child node');
    }
    return this.child;
  }
}

function parseCompositeArgs(
  optionsOrConfigure?: Record<string, unknown> | ((b: CompositeBuilder) => void),
  configure?: (b: CompositeBuilder) => void,
): { strategy?: any; configureFn?: (b: CompositeBuilder) => void } {
  if (typeof optionsOrConfigure === 'function') {
    return { configureFn: optionsOrConfigure };
  }
  return {
    strategy: optionsOrConfigure?.strategy,
    configureFn: configure,
  };
}

export class TreeBuilder extends CompositeBuilder {
  private treeName: string;

  constructor(name: string) {
    super();
    this.treeName = name;
  }

  build(): BehaviorTree {
    const children = this.getChildren();
    if (children.length !== 1) {
      throw new Error(`Tree must have exactly one root node, got ${children.length}`);
    }
    return new BehaviorTree({ name: this.treeName, root: children[0] });
  }
}
```

### Step 4: Run test to verify it passes

Run: `npx vitest run src/builder/tree-builder.test.ts`
Expected: PASS (all 12 tests)

### Step 5: Commit

```bash
git add src/builder/tree-builder.ts src/builder/tree-builder.test.ts
git commit -m "feat: implement fluent builder API for composing behavior trees"
```
