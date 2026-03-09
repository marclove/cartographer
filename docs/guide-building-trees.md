# Three Construction Approaches

Cartographer provides three ways to build behavior trees. This guide constructs the same tree using each approach so you can compare them directly.

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

Composite nodes accept an optional strategy object:

```typescript
b.selector('name', { strategy: myStrategy }, (b) => { ... });
```

---

## Approach 3: Declarative YAML

Define the tree structure in YAML and bind behavior through a registry.

```yaml
name: content-pipeline
root:
  type: selector
  name: content-pipeline
  children:
    - type: sequence
      name: primary-path
      children:
        - type: condition
          name: has-input
          ref: hasInput
        - type: action
          name: process-input
          ref: processInput
    - type: sequence
      name: fallback-path
      children:
        - type: condition
          name: has-cache
          ref: hasCache
        - type: action
          name: use-cache
          ref: useCache
```

Load the YAML and wire up behavior with `TreeRegistry`:

```typescript
import { TreeLoader, TreeRegistry, NodeStatus } from 'cartographer';

const registry = new TreeRegistry();
registry.registerCondition('hasInput', (ctx) => ctx.blackboard.has('input'));
registry.registerAction('processInput', async (ctx) => {
  const input = ctx.blackboard.get<string>('input');
  ctx.blackboard.set('result', `Processed: ${input}`);
  return NodeStatus.SUCCESS;
});
registry.registerCondition('hasCache', (ctx) => ctx.blackboard.has('cache'));
registry.registerAction('useCache', (ctx) => {
  ctx.blackboard.set('result', ctx.blackboard.get('cache'));
  return NodeStatus.SUCCESS;
});

const tree = TreeLoader.fromYAML(yamlString, registry);
```

**TreeRegistry methods:** `registerAction`, `registerCondition`, `registerSchema`, `registerStrategy`, `getAction`, `getCondition`, `getSchema`, `getStrategy`.

**TreeLoader static methods:** `fromYAML(yamlString, registry)`, `fromConfig(config, registry)`.

---

## Trade-offs

| Approach | Best for | Trade-offs |
|----------|----------|------------|
| Programmatic | Full type safety, complex logic | Verbose, harder to visualize structure |
| Builder | Readability, rapid prototyping | Slightly less flexible than programmatic |
| YAML | External configuration, non-dev editing | Requires registry, no inline functions |

---

## Where to go next

- [Node types and lifecycle](guide-nodes.md)
- [Composite nodes: selector, sequence, parallel](guide-composites.md)
- [Decorator nodes: inverter, retry, guard, and more](guide-decorators.md)
