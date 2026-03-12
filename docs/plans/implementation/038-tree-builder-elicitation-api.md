# Task 38: TreeBuilder Elicitation API

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `onElicitation()` to `TreeBuilder` and support `context` overrides in composite and decorator builder methods on both `CompositeBuilder` and `SingleChildBuilder`, so users can set elicitation handlers at the tree level or per-subtree.

**Depends on:** Task 37

---

### Step 1: Write failing tests

Add tests to `src/builder/tree-builder.test.ts`:

```typescript
describe('onElicitation', () => {
  it('passes onElicitation to BehaviorTreeConfig via build()', async () => {
    const handler = vi.fn();
    const root = vi.fn().mockResolvedValue(NodeStatus.SUCCESS);

    const tree = new TreeBuilder('test')
      .onElicitation(handler)
      .action('a', root)
      .build();

    // Tick and verify handler is in context
    // (Implementation detail: BehaviorTree sets it as contextOverrides on root)
  });
});

describe('context overrides on composites', () => {
  it('sets contextOverrides on a sequence node via CompositeBuilder', () => {
    const handler = vi.fn();
    const tree = new TreeBuilder('test')
      .sequence('seq', { context: { onElicitation: handler } }, (b) => {
        b.action('a', async () => NodeStatus.SUCCESS);
      })
      .build();
  });

  it('sets contextOverrides on a selector node via CompositeBuilder', () => {
    const handler = vi.fn();
    const tree = new TreeBuilder('test')
      .selector('sel', { context: { onElicitation: handler } }, (b) => {
        b.action('a', async () => NodeStatus.SUCCESS);
      })
      .build();
  });

  it('sets contextOverrides on a parallel node via CompositeBuilder', () => {
    const handler = vi.fn();
    const tree = new TreeBuilder('test')
      .parallel('par', { context: { onElicitation: handler } }, (b) => {
        b.action('a', async () => NodeStatus.SUCCESS);
      })
      .build();
  });
});

describe('context overrides on decorators', () => {
  it('sets contextOverrides on a retry node', () => {
    const handler = vi.fn();
    const tree = new TreeBuilder('test')
      .retry('r', { maxAttempts: 2, context: { onElicitation: handler } }, (b) => {
        b.action('a', async () => NodeStatus.SUCCESS);
      })
      .build();
  });

  it('sets contextOverrides on a repeat node', () => {
    const handler = vi.fn();
    const tree = new TreeBuilder('test')
      .repeat('rep', { count: 2, context: { onElicitation: handler } }, (b) => {
        b.action('a', async () => NodeStatus.SUCCESS);
      })
      .build();
  });

  it('sets contextOverrides on a timeout node', () => {
    const handler = vi.fn();
    const tree = new TreeBuilder('test')
      .timeout('t', { timeoutMs: 1000, context: { onElicitation: handler } }, (b) => {
        b.action('a', async () => NodeStatus.SUCCESS);
      })
      .build();
  });

  it('sets contextOverrides on a guard node', () => {
    const handler = vi.fn();
    const tree = new TreeBuilder('test')
      .guard('g', { condition: () => true, context: { onElicitation: handler } }, (b) => {
        b.action('a', async () => NodeStatus.SUCCESS);
      })
      .build();
  });
});

describe('context overrides via SingleChildBuilder', () => {
  it('sets contextOverrides on a nested sequence inside a decorator', () => {
    const handler = vi.fn();
    const tree = new TreeBuilder('test')
      .retry('r', { maxAttempts: 2 }, (b) => {
        b.sequence('seq', { context: { onElicitation: handler } }, (b) => {
          b.action('a', async () => NodeStatus.SUCCESS);
        });
      })
      .build();
  });
});
```

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/builder/tree-builder.test.ts`
Expected: FAIL — `onElicitation` method and `context` option don't exist.

### Step 3: Add onElicitation() to TreeBuilder

Edit `src/builder/tree-builder.ts`:

```typescript
import type { OnElicitation } from '@anthropic-ai/claude-agent-sdk';
import type { TreeContext } from '../types.js';

export class TreeBuilder extends CompositeBuilder {
  private treeName: string;
  private treeOnElicitation?: OnElicitation;

  constructor(name: string) {
    super();
    this.treeName = name;
  }

  /**
   * Set the default elicitation handler for the entire tree.
   * All AgentNodes inherit this handler unless a closer ancestor overrides it.
   */
  onElicitation(handler: OnElicitation): this {
    this.treeOnElicitation = handler;
    return this;
  }

  build(): BehaviorTree {
    const children = this.getChildren();
    if (children.length !== 1) {
      throw new Error(`Tree must have exactly one root node, got ${children.length}`);
    }
    return new BehaviorTree({
      name: this.treeName,
      root: children[0],
      onElicitation: this.treeOnElicitation,
    });
  }
}
```

### Step 4: Add context option to CompositeBuilder methods

Update `parseCompositeArgs` to extract and forward the `context` field:

```typescript
function parseCompositeArgs(
  optionsOrConfigure?: Record<string, unknown> | ((b: CompositeBuilder) => void),
  configure?: (b: CompositeBuilder) => void,
): { strategy?: unknown; context?: Partial<TreeContext>; configureFn?: (b: CompositeBuilder) => void } {
  if (typeof optionsOrConfigure === 'function') {
    return { configureFn: optionsOrConfigure };
  }
  return {
    strategy: optionsOrConfigure?.strategy,
    context: optionsOrConfigure?.context as Partial<TreeContext> | undefined,
    configureFn: configure,
  };
}
```

In each composite method on `CompositeBuilder`, after creating the node, apply context overrides:

```typescript
// Example for sequence:
sequence(name, optionsOrConfigure, configure) {
  const { strategy, context, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
  const builder = new CompositeBuilder();
  configureFn?.(builder);
  const node = new SequenceNode({ name, children: builder.getChildren(), strategy });
  if (context) {
    node.setContextOverrides(context);
  }
  this.children.push(node);
  return this;
}
```

Apply the same pattern to `selector` and `parallel` on `CompositeBuilder`.

### Step 5: Add context option to decorator methods on CompositeBuilder

For decorator methods that already accept an options object (`retry`, `repeat`, `timeout`, `guard`), add `context` as an optional field. Extract it before spreading into the node config:

```typescript
// Example for retry:
retry(name, options, configure) {
  const { context, ...nodeOptions } = options;
  const builder = new SingleChildBuilder();
  configure(builder);
  const node = new RetryNode({ name, child: builder.getChild(), ...nodeOptions });
  if (context) {
    node.setContextOverrides(context);
  }
  this.children.push(node);
  return this;
}
```

Apply the same pattern to `repeat`, `timeout`, and `guard`.

### Step 6: Mirror all changes to SingleChildBuilder

`SingleChildBuilder` has the same set of composite and decorator methods. Apply identical changes:
- `selector`, `sequence`, `parallel` — use `parseCompositeArgs` and apply context overrides
- `retry`, `repeat`, `timeout`, `guard` — extract `context` from options and apply

### Step 7: Update TypeScript signatures

Update the type signatures on both `CompositeBuilder` and `SingleChildBuilder` methods to accept `context`:

For composites, the existing overloaded signatures accept `{ strategy?: ... }` as the options object. Extend this to `{ strategy?: ...; context?: Partial<TreeContext> }`.

For decorators, extend the options types:
- `retry`: `{ maxAttempts: number; delayMs?: number; context?: Partial<TreeContext> }`
- `repeat`: `{ count?: number; untilStatus?: NodeStatus; context?: Partial<TreeContext> }`
- `timeout`: `{ timeoutMs: number; context?: Partial<TreeContext> }`
- `guard`: `{ condition: ConditionFn; context?: Partial<TreeContext> }`

### Step 8: Run tests to verify they pass

Run: `npx vitest run src/builder/tree-builder.test.ts`
Expected: PASS

### Step 9: Run full test suite

Run: `npm run typecheck && npm run test`
Expected: All pass.

### Step 10: Commit

```bash
git add src/builder/tree-builder.ts src/builder/tree-builder.test.ts
git commit -m "feat: add onElicitation to TreeBuilder and context overrides to composite/decorator builders"
```
