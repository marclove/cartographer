# Configuration API Reference

## TreeRegistry

```typescript
import { TreeRegistry } from 'cartographer';
```

A general-purpose named registry for actions, conditions, and strategies.

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
```
