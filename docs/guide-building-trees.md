# Two Construction Approaches

Cartographer provides two ways to build behavior trees. This guide constructs the same tree using each approach so you can compare them directly.

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

## Trade-offs

| Approach | Best for | Trade-offs |
|----------|----------|------------|
| Programmatic | Full type safety, complex logic | Verbose, harder to visualize structure |
| Builder | Readability, rapid prototyping | Slightly less flexible than programmatic |

---

## Where to go next

- [Node types and lifecycle](guide-nodes.md)
- [Composite nodes: selector, sequence, parallel](guide-composites.md)
- [Decorator nodes: inverter, retry, guard, and more](guide-decorators.md)
