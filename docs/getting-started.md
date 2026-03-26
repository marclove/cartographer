# Quick Start

This guide walks you through installing Cartographer and building your first behavior tree.

## Prerequisites

- Node.js 22 or later
- TypeScript (recommended)

## Installation

```bash
npm install cartographer
```

This also installs the `cartographer` CLI binary -- see the [CLI Runner guide](guide-cli.md) for running trees from the command line.

## Your First Tree

The example below creates a sequence with two actions: one writes a value to the blackboard, and the other reads it back.

### Using TreeBuilder

`TreeBuilder` provides a fluent API for declaring trees. You add exactly one root node, then call `.build()` to get a `BehaviorTree` instance.

```typescript
import { TreeBuilder, NodeStatus } from 'cartographer';

const tree = new TreeBuilder('hello-tree')
  .sequence('main', (b) => {
    b.action('write-greeting', (ctx) => {
      ctx.blackboard.set('greeting', 'Hello, Cartographer!');
      return NodeStatus.SUCCESS;
    });
    b.action('read-greeting', (ctx) => {
      const msg = ctx.blackboard.get<string>('greeting');
      console.log(msg);
      return NodeStatus.SUCCESS;
    });
  })
  .build();

const { status, blackboard } = await tree.run();
console.log(status);    // 'success'
console.log(blackboard); // { greeting: 'Hello, Cartographer!' }
```

`tree.run()` ticks the tree once and returns the resulting status along with a snapshot of the blackboard. For repeated execution, see the [Application Server guide](guide-app-server.md) to run your tree as a persistent service with auto-ticking.

### Programmatic Approach

If you prefer explicit control, you can instantiate nodes directly and wire them together yourself.

```typescript
import { BehaviorTree, SequenceNode, ActionNode, NodeStatus } from 'cartographer';

const tree = new BehaviorTree({
  name: 'hello-tree',
  root: new SequenceNode({
    name: 'main',
    children: [
      new ActionNode({
        name: 'write-greeting',
        action: (ctx) => {
          ctx.blackboard.set('greeting', 'Hello, Cartographer!');
          return NodeStatus.SUCCESS;
        },
      }),
      new ActionNode({
        name: 'read-greeting',
        action: (ctx) => {
          console.log(ctx.blackboard.get<string>('greeting'));
          return NodeStatus.SUCCESS;
        },
      }),
    ],
  }),
});

const { status, blackboard } = await tree.run();
```

Both approaches produce identical trees. The builder is convenient for most cases; direct instantiation is useful when you need to construct trees dynamically or integrate with custom node types.

## Where to Go Next

- [Core Concepts](concepts.md) -- understand the execution model, blackboard, and node lifecycle.
- [Building Trees](guide-building-trees.md) -- deeper coverage of `TreeBuilder`, nesting, and composition patterns.
- [Node Reference](guide-nodes.md) -- catalog of built-in node types (actions, conditions, sequences, selectors, decorators).
- [CLI Runner](guide-cli.md) -- run, inspect, and scaffold trees from the command line.
- [Content Pipeline](../apps/content-pipeline/) and [Scheduled Monitor](../apps/scheduled-monitor/) -- two complete, runnable programs that exercise the framework end-to-end with real Claude API calls.
