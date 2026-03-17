# Building Trees

Cartographer provides multiple ways to build behavior trees: direct instantiation, the fluent builder with inline functions, and the builder with registry references. This guide constructs the same tree using each approach so you can compare them directly.

**Target tree:**

```
[Selector: content-pipeline]
  ├── [Sequence: primary-path]
  │     ├── [Condition: has-input]
  │     └── [Action: process-input]
  └── [Sequence: fallback-path]
        ├── [Condition: has-cache]
        └── [Action: use-cache]
```

A selector tries two sequence branches in order. The primary path checks for input and processes it; the fallback path checks for a cache and uses it.

---

## Approach 1: Programmatic (Direct Instantiation)

Instantiate node classes directly and compose them into a tree.

```typescript
import {
  BehaviorTree, SelectorNode, SequenceNode,
  ActionNode, ConditionNode, NodeStatus,
} from 'cartographer';

const tree = new BehaviorTree({
  name: 'content-pipeline',
  root: new SelectorNode({
    name: 'content-pipeline',
    children: [
      new SequenceNode({
        name: 'primary-path',
        children: [
          new ConditionNode({
            name: 'has-input',
            condition: (ctx) => ctx.blackboard.has('input'),
          }),
          new ActionNode({
            name: 'process-input',
            action: async (ctx) => {
              const input = ctx.blackboard.get<string>('input');
              ctx.blackboard.set('result', `Processed: ${input}`);
              return NodeStatus.SUCCESS;
            },
          }),
        ],
      }),
      new SequenceNode({
        name: 'fallback-path',
        children: [
          new ConditionNode({
            name: 'has-cache',
            condition: (ctx) => ctx.blackboard.has('cache'),
          }),
          new ActionNode({
            name: 'use-cache',
            action: (ctx) => {
              ctx.blackboard.set('result', ctx.blackboard.get('cache'));
              return NodeStatus.SUCCESS;
            },
          }),
        ],
      }),
    ],
  }),
});
```

---

## Approach 2: Fluent Builder

`TreeBuilder` provides a chainable API that mirrors the tree structure with nesting callbacks.

```typescript
import { TreeBuilder, NodeStatus } from 'cartographer';

const tree = new TreeBuilder('content-pipeline')
  .selector('content-pipeline', (b) => {
    b.sequence('primary-path', (b) => {
      b.condition('has-input', (ctx) => ctx.blackboard.has('input'));
      b.action('process-input', async (ctx) => {
        const input = ctx.blackboard.get<string>('input');
        ctx.blackboard.set('result', `Processed: ${input}`);
        return NodeStatus.SUCCESS;
      });
    });
    b.sequence('fallback-path', (b) => {
      b.condition('has-cache', (ctx) => ctx.blackboard.has('cache'));
      b.action('use-cache', (ctx) => {
        ctx.blackboard.set('result', ctx.blackboard.get('cache'));
        return NodeStatus.SUCCESS;
      });
    });
  })
  .build();
```

`TreeBuilder` extends `CompositeBuilder`. A builder must have exactly one root node; call `.build()` to produce the `BehaviorTree` instance.

**CompositeBuilder methods:** `action`, `condition`, `agent`, `selector`, `sequence`, `parallel`, `inverter`, `repeat`, `retry`, `alwaysSucceed`, `alwaysFail`, `timeout`, `guard`.

Composite nodes accept an optional options object for strategies and context overrides:

```typescript
b.selector('name', { strategy: myStrategy }, (b) => { ... });
```

The `context` option applies context overrides to a subtree, which is how you scope configuration like elicitation handlers to specific branches:

```typescript
b.sequence('scoped', { context: { onElicitation: myHandler } }, (b) => {
  b.agent('worker', { prompt: 'work' }); // inherits myHandler
});
```

`TreeBuilder` also exposes `onElicitation()` for setting a tree-wide default:

```typescript
const tree = new TreeBuilder('my-tree')
  .onElicitation(handler)
  .sequence('root', (b) => { ... })
  .build();
```

---

## Approach 3: Builder with Registry References

Define actions, conditions, and strategies in separate files and register them by name. Then compose the tree using the fluent builder with string references instead of inline functions. Pass the registry as the second argument to `TreeBuilder`.

```typescript
// actions/process-input.ts
import { NodeStatus } from 'cartographer';
import type { TreeContext } from 'cartographer';

export const processInput = async (ctx: TreeContext) => {
  const input = ctx.blackboard.get<string>('input');
  ctx.blackboard.set('result', `Processed: ${input}`);
  return NodeStatus.SUCCESS;
};

// registry.ts
import { TreeRegistry, NodeStatus } from 'cartographer';
import { processInput } from './actions/process-input.js';

const registry = new TreeRegistry();
registry.registerCondition('hasInput', (ctx) => ctx.blackboard.has('input'));
registry.registerAction('processInput', processInput);
registry.registerCondition('hasCache', (ctx) => ctx.blackboard.has('cache'));
registry.registerAction('useCache', (ctx) => {
  ctx.blackboard.set('result', ctx.blackboard.get('cache'));
  return NodeStatus.SUCCESS;
});
export { registry };

// tree.ts
import { TreeBuilder } from 'cartographer';
import { registry } from './registry.js';

const tree = new TreeBuilder('content-pipeline', registry)
  .selector('content-pipeline', (b) => {
    b.sequence('primary-path', (b) => {
      b.condition('has-input', 'hasInput');
      b.action('process-input', 'processInput');
    });
    b.sequence('fallback-path', (b) => {
      b.condition('has-cache', 'hasCache');
      b.action('use-cache', 'useCache');
    });
  })
  .build();
```

Registry references work for:
- **Actions**: `b.action('name', 'registry-key')` instead of `b.action('name', fn)`
- **Conditions**: `b.condition('name', 'registry-key')` instead of `b.condition('name', fn)`
- **Strategies**: `b.selector('name', { strategy: 'registry-key' }, ...)` instead of `{ strategy: instance }`
- **Guard conditions**: `b.guard('name', { condition: 'registry-key' }, ...)` instead of `{ condition: fn }`

Inline functions and registry references can be mixed freely within the same tree.

---

## Trade-offs

| Approach | Best for | Trade-offs |
|----------|----------|------------|
| Programmatic | Full type safety, complex logic | Verbose, harder to visualize structure |
| Builder (inline) | Readability, rapid prototyping | Slightly less flexible than programmatic |
| Builder (registry) | Modular codebases, reusable components | Requires registry setup, string keys not type-checked |

---

## Where to go next

- [Node types and lifecycle](guide-nodes.md)
- [Composite nodes: selector, sequence, parallel](guide-composites.md)
- [Decorator nodes: inverter, retry, guard, and more](guide-decorators.md)
