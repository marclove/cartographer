# Configuration API Reference

## TreeRegistry

```typescript
import { TreeRegistry } from 'cartographer';
```

A general-purpose named registry for actions, conditions, and strategies. When passed to `TreeBuilder` as the second constructor argument, registered entries can be referenced by name in the builder's `action`, `condition`, `guard`, and composite strategy options.

### Constructor

```typescript
new TreeRegistry()
```

### Methods

#### registerAction

```typescript
registerAction(name: string, fn: (context: TreeContext) => Promise<NodeStatus> | NodeStatus): void
```

Registers a named action function.

#### registerCondition

```typescript
registerCondition(name: string, fn: (context: TreeContext) => Promise<boolean> | boolean): void
```

Registers a named condition function.

#### registerStrategy

```typescript
registerStrategy(name: string, strategy: SelectionStrategy | ExecutionStrategy | ParallelStrategy): void
```

Registers a named strategy for use by composite nodes (`selector`, `sequence`, `parallel`).

#### getAction

```typescript
getAction(name: string): ActionFn
```

Returns the registered action function. Throws if not found: `Action "${name}" not found in registry`.

#### getCondition

```typescript
getCondition(name: string): ConditionFn
```

Returns the registered condition function. Throws if not found.

#### getStrategy

```typescript
getStrategy(name: string): AnyStrategy
```

Returns the registered strategy. Throws if not found.

### Example

```typescript
import { TreeRegistry, NodeStatus } from 'cartographer';

const registry = new TreeRegistry();
registry.registerAction('fetchData', async (ctx) => {
  // fetch logic
  return NodeStatus.SUCCESS;
});
registry.registerCondition('hasData', (ctx) => ctx.blackboard.has('data'));

// Use with TreeBuilder
const tree = new TreeBuilder('my-tree', registry)
  .sequence('root', (b) => {
    b.condition('check', 'hasData');
    b.action('fetch', 'fetchData');
  })
  .build();
```
