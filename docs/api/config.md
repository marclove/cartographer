# Configuration API Reference

## TreeRegistry

```typescript
import { TreeRegistry } from 'cartographer';
```

A registry for actions, conditions, and strategies referenced by name in YAML configs.

### Constructor

```typescript
new TreeRegistry()
```

### Methods

#### registerAction

```typescript
registerAction(name: string, fn: (context: TreeContext) => Promise<NodeStatus> | NodeStatus): void
```

Registers a named action function that can be referenced from YAML configs via `ref`.

#### registerCondition

```typescript
registerCondition(name: string, fn: (context: TreeContext) => Promise<boolean> | boolean): void
```

Registers a named condition function that can be referenced from YAML configs via `ref`.

#### registerStrategy

```typescript
registerStrategy(name: string, strategy: SelectionStrategy | ExecutionStrategy | ParallelStrategy): void
```

Registers a named strategy for use by composite nodes (`selector`, `sequence`, `parallel`) via `strategy.ref`.

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

---

## TreeLoader

```typescript
import { TreeLoader } from 'cartographer';
```

Static class -- no constructor. Builds `BehaviorTree` instances from YAML strings or config objects.

### Static Methods

#### fromYAML

```typescript
static fromYAML(yamlString: string, registry: TreeRegistry): BehaviorTree
```

Parses a YAML string, validates it has a `root` field, and delegates to `fromConfig`.

#### fromConfig

```typescript
static fromConfig(config: TreeConfig, registry: TreeRegistry): BehaviorTree
```

Recursively builds the node tree from a config object.

### TreeConfig Shape

Internal interface (not exported):

```typescript
interface TreeConfig {
  name: string;
  root: NodeConfig;
}
```

### YAML Node Types

The loader recognizes the following node `type` values:

| Type | Required Fields | Optional Fields |
|------|----------------|-----------------|
| `action` | `name`, `ref` (registry key) | -- |
| `condition` | `name`, `ref` (registry key) | -- |
| `agent` | `name`, `prompt` | `blackboardNamespace`, `cache`, `options` (SDK options object) |
| `selector` | `name` | `children`, `strategy.ref` |
| `sequence` | `name` | `children`, `strategy.ref` |
| `parallel` | `name` | `children`, `strategy.ref` |
| `inverter` | `name`, `child` | -- |
| `repeat` | `name`, `child` | `count`, `untilStatus` |
| `retry` | `name`, `child`, `maxAttempts` | `delayMs` |
| `alwaysSucceed` | `name`, `child` | -- |
| `alwaysFail` | `name`, `child` | -- |
| `timeout` | `name`, `child`, `timeoutMs` | -- |
| `guard` | `name`, `child`, `conditionRef` | -- |

**Registry key references:**

- `action` and `condition` nodes use `ref` to look up a registered action or condition by name.
- `guard` nodes use `conditionRef` to look up a registered condition.
- Composite nodes (`selector`, `sequence`, `parallel`) use `strategy.ref` to look up a registered strategy.
- `agent` nodes pass `options` directly to `AgentNode` as the SDK options object.

### Example YAML

```yaml
name: my-tree
root:
  type: sequence
  name: main
  children:
    - type: condition
      name: check-ready
      ref: isReady
    - type: action
      name: do-work
      ref: doWork
```

```typescript
import { TreeLoader, TreeRegistry, NodeStatus } from 'cartographer';

const registry = new TreeRegistry();
registry.registerCondition('isReady', (ctx) => ctx.blackboard.has('input'));
registry.registerAction('doWork', async (ctx) => NodeStatus.SUCCESS);

const tree = TreeLoader.fromYAML(yamlString, registry);
const { status } = await tree.run();
```
