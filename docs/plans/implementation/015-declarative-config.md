# Task 15: Declarative Config (Registry, Loader, Schema)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the YAML/JSON config loader with a registry for user-defined functions and schemas.

**Architecture:** `TreeRegistry` stores named actions, conditions, schemas, and strategies. `TreeLoader` parses a YAML/JSON config file, resolves `ref` fields against the registry, and constructs the node tree.

**Tech Stack:** TypeScript, yaml, zod

---

### Step 1: Write failing tests for TreeRegistry

Create `src/config/registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TreeRegistry } from './registry.js';
import { NodeStatus } from '../types.js';
import { DefaultSelectionStrategy } from '../strategies/default-selection.js';
import { z } from 'zod';

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

  it('registers and retrieves schemas', () => {
    const registry = new TreeRegistry();
    const schema = z.object({ value: z.number() });
    registry.registerSchema('MySchema', schema);

    expect(registry.getSchema('MySchema')).toBe(schema);
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

  it('throws on missing schema', () => {
    const registry = new TreeRegistry();
    expect(() => registry.getSchema('missing')).toThrow('Schema "missing" not found');
  });

  it('throws on missing strategy', () => {
    const registry = new TreeRegistry();
    expect(() => registry.getStrategy('missing')).toThrow('Strategy "missing" not found');
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/config/registry.test.ts`
Expected: FAIL

### Step 3: Implement TreeRegistry

Create `src/config/registry.ts`:

```typescript
import type { z } from 'zod';
import type {
  TreeContext, NodeStatus, SelectionStrategy, ExecutionStrategy, ParallelStrategy,
} from '../types.js';

type ActionFn = (context: TreeContext) => Promise<NodeStatus> | NodeStatus;
type ConditionFn = (context: TreeContext) => Promise<boolean> | boolean;
type AnyStrategy = SelectionStrategy | ExecutionStrategy | ParallelStrategy;

export class TreeRegistry {
  private actions = new Map<string, ActionFn>();
  private conditions = new Map<string, ConditionFn>();
  private schemas = new Map<string, z.ZodType>();
  private strategies = new Map<string, AnyStrategy>();

  registerAction(name: string, fn: ActionFn): void {
    this.actions.set(name, fn);
  }

  registerCondition(name: string, fn: ConditionFn): void {
    this.conditions.set(name, fn);
  }

  registerSchema(name: string, schema: z.ZodType): void {
    this.schemas.set(name, schema);
  }

  registerStrategy(name: string, strategy: AnyStrategy): void {
    this.strategies.set(name, strategy);
  }

  getAction(name: string): ActionFn {
    const fn = this.actions.get(name);
    if (!fn) throw new Error(`Action "${name}" not found in registry`);
    return fn;
  }

  getCondition(name: string): ConditionFn {
    const fn = this.conditions.get(name);
    if (!fn) throw new Error(`Condition "${name}" not found in registry`);
    return fn;
  }

  getSchema(name: string): z.ZodType {
    const schema = this.schemas.get(name);
    if (!schema) throw new Error(`Schema "${name}" not found in registry`);
    return schema;
  }

  getStrategy(name: string): AnyStrategy {
    const strategy = this.strategies.get(name);
    if (!strategy) throw new Error(`Strategy "${name}" not found in registry`);
    return strategy;
  }
}
```

### Step 4: Run test to verify it passes

Run: `npx vitest run src/config/registry.test.ts`
Expected: PASS (all 8 tests)

### Step 5: Write failing tests for TreeLoader

Create `src/config/loader.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TreeLoader } from './loader.js';
import { TreeRegistry } from './registry.js';
import { NodeStatus } from '../types.js';
import { DefaultParallelStrategy } from '../strategies/default-parallel.js';
import { z } from 'zod';

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
    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it('loads agent nodes with inline config', async () => {
    const registry = new TreeRegistry();
    registry.registerSchema('TestSchema', z.object({ result: z.string() }));

    const config = {
      name: 'agent-tree',
      root: {
        type: 'agent',
        name: 'classify',
        mode: 'structured',
        prompt: 'Classify this input',
        outputSchema: 'TestSchema',
        model: 'sonnet',
      },
    };

    const tree = TreeLoader.fromConfig(config, registry);
    // Just verify it builds — actual agent execution is tested elsewhere
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
```

### Step 6: Run test to verify it fails

Run: `npx vitest run src/config/loader.test.ts`
Expected: FAIL

### Step 7: Implement TreeLoader

Create `src/config/loader.ts`:

```typescript
import YAML from 'yaml';
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
import type { BTreeNode } from '../types.js';
import type { TreeRegistry } from './registry.js';

interface NodeConfig {
  type: string;
  name: string;
  ref?: string;
  children?: NodeConfig[];
  child?: NodeConfig;
  strategy?: { type?: string; ref?: string; prompt?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface TreeConfig {
  name: string;
  root: NodeConfig;
}

export class TreeLoader {
  static fromYAML(yamlString: string, registry: TreeRegistry): BehaviorTree {
    const config = YAML.parse(yamlString) as TreeConfig;
    return TreeLoader.fromConfig(config, registry);
  }

  static fromConfig(config: TreeConfig, registry: TreeRegistry): BehaviorTree {
    const root = TreeLoader.buildNode(config.root, registry);
    return new BehaviorTree({ name: config.name, root });
  }

  private static buildNode(config: NodeConfig, registry: TreeRegistry): BTreeNode {
    switch (config.type) {
      case 'action':
        return new ActionNode({
          name: config.name,
          action: registry.getAction(config.ref!),
        });

      case 'condition':
        return new ConditionNode({
          name: config.name,
          condition: registry.getCondition(config.ref!),
        });

      case 'agent':
        return new AgentNode({
          name: config.name,
          mode: config.mode as 'structured' | 'agentic',
          prompt: config.prompt as string,
          outputSchema: config.outputSchema
            ? registry.getSchema(config.outputSchema as string)
            : undefined,
          model: config.model as any,
          effort: config.effort as any,
          allowedTools: config.allowedTools as string[] | undefined,
          permissionMode: config.permissionMode as any,
          maxTurns: config.maxTurns as number | undefined,
          maxBudgetUsd: config.maxBudgetUsd as number | undefined,
          systemPrompt: config.systemPrompt as string | undefined,
          blackboardNamespace: config.blackboardNamespace as string | undefined,
        });

      case 'selector':
        return new SelectorNode({
          name: config.name,
          children: (config.children ?? []).map((c) => TreeLoader.buildNode(c, registry)),
          strategy: config.strategy?.ref
            ? (registry.getStrategy(config.strategy.ref) as any)
            : undefined,
        });

      case 'sequence':
        return new SequenceNode({
          name: config.name,
          children: (config.children ?? []).map((c) => TreeLoader.buildNode(c, registry)),
          strategy: config.strategy?.ref
            ? (registry.getStrategy(config.strategy.ref) as any)
            : undefined,
        });

      case 'parallel':
        return new ParallelNode({
          name: config.name,
          children: (config.children ?? []).map((c) => TreeLoader.buildNode(c, registry)),
          strategy: config.strategy?.ref
            ? (registry.getStrategy(config.strategy.ref) as any)
            : undefined,
        });

      case 'inverter':
        return new InverterNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child!, registry),
        });

      case 'repeat':
        return new RepeatNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child!, registry),
          count: config.count as number | undefined,
          untilStatus: config.untilStatus as any,
        });

      case 'retry':
        return new RetryNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child!, registry),
          maxAttempts: config.maxAttempts as number,
          delayMs: config.delayMs as number | undefined,
        });

      case 'alwaysSucceed':
        return new AlwaysSucceedNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child!, registry),
        });

      case 'alwaysFail':
        return new AlwaysFailNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child!, registry),
        });

      case 'timeout':
        return new TimeoutNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child!, registry),
          timeoutMs: config.timeoutMs as number,
        });

      case 'guard':
        return new GuardNode({
          name: config.name,
          child: TreeLoader.buildNode(config.child!, registry),
          condition: registry.getCondition(config.conditionRef as string),
        });

      default:
        throw new Error(`Unknown node type: ${config.type}`);
    }
  }
}
```

### Step 8: Run test to verify it passes

Run: `npx vitest run src/config/loader.test.ts`
Expected: PASS (all 9 tests)

### Step 9: Commit

```bash
git add src/config/registry.ts src/config/registry.test.ts src/config/loader.ts src/config/loader.test.ts
git commit -m "feat: implement declarative config with registry and YAML/JSON loader"
```
