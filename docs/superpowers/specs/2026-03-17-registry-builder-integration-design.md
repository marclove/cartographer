# Registry + Builder Integration Design

## Context

After removing `TreeLoader` and YAML support, `TreeRegistry` has no consumers. The registry's value — mapping string names to action/condition/strategy implementations — pairs naturally with `TreeBuilder`. This integration lets users define each action, condition, and strategy in its own file, register them, and compose trees with the fluent builder using string references instead of inline functions.

## Design

### Overloaded Signatures

Rather than adding separate `*Ref` methods, existing builder methods gain string overloads. TypeScript discriminates `string` from function/object at the type level; runtime uses `typeof`.

**Actions and conditions** — second parameter accepts either a function (existing) or a string registry key (new):

```ts
// Inline (existing)
b.action('step1', async (ctx) => { ... });
b.condition('check', (ctx) => ctx.blackboard.has('token'));

// Registry reference (new)
b.action('step1', 'fetch-user');
b.condition('check', 'is-authenticated');
```

**Composite strategies** — `strategy` field accepts either an object (existing) or a string registry key (new):

```ts
// Inline (existing)
b.selector('root', { strategy: myStrategyInstance }, (b) => { ... });

// Registry reference (new)
b.selector('root', { strategy: 'adaptive-order' }, (b) => { ... });
```

**Guard conditions** — `condition` field accepts either a function (existing) or a string registry key (new):

```ts
// Inline (existing)
b.guard('gate', { condition: (ctx) => ctx.blackboard.has('auth') }, (b) => { ... });

// Registry reference (new)
b.guard('gate', { condition: 'has-auth' }, (b) => { ... });
```

### Registry Threading

The registry must flow from `TreeBuilder` through all nested builders.

- `TreeBuilder` constructor gains an optional second parameter: `new TreeBuilder('name', registry)`. Forwards to `super(registry)`.
- `CompositeBuilder` and `SingleChildBuilder` constructors gain an optional `registry?: TreeRegistry` parameter (internal — not part of the public API for direct use)
- *All* internal builder instantiation sites must forward the registry. This includes composite methods (`new CompositeBuilder(this.registry)` — 3 sites in `CompositeBuilder`, 3 in `SingleChildBuilder`) and decorator methods (`new SingleChildBuilder(this.registry)` — 7 sites in each class).
- Calling a string overload without a registry throws: `Cannot resolve registry reference "fetch-user": no registry provided to TreeBuilder`

**Both `CompositeBuilder` and `SingleChildBuilder`** need the same string overloads — the two classes mirror each other's leaf/composite/decorator methods. The resolve helpers (`resolveAction`, `resolveCondition`, `resolveStrategy`) can be shared by extracting them into a private base class or standalone functions that take the registry as a parameter.

### Error Behavior

Two layers of errors, each with a distinct message:

1. **No registry provided** (builder-level): `Cannot resolve registry reference "fetch-user": no registry provided to TreeBuilder`
2. **Key not found** (registry-level): `Action "fetch-user" not found in registry` — thrown by `TreeRegistry.getAction()` et al.

### Type Changes

```ts
// In tree-builder.ts (local type aliases):
type ActionArg = ActionFn | string;
type ConditionArg = ConditionFn | string;

// Composite options gain string-accepting strategy:
{ strategy?: SelectionStrategy | string; context?: Partial<TreeContext> }
{ strategy?: ExecutionStrategy | string; context?: Partial<TreeContext> }
{ strategy?: ParallelStrategy | string; context?: Partial<TreeContext> }

// Guard options gain string-accepting condition:
{ condition: ConditionFn | string; context?: Partial<TreeContext> }
```

### Resolution Logic

Each method that gains the string overload follows this pattern:

```ts
action(name: string, fnOrRef: ActionFn | string): this {
  const fn = typeof fnOrRef === 'string'
    ? this.resolveAction(fnOrRef)
    : fnOrRef;
  this.children.push(new ActionNode({ name, action: fn }));
  return this;
}
```

Standalone resolve helpers check for the registry and delegate:

```ts
function resolveAction(registry: TreeRegistry | undefined, ref: string): ActionFn {
  if (!registry) {
    throw new Error(`Cannot resolve registry reference "${ref}": no registry provided to TreeBuilder`);
  }
  return registry.getAction(ref);
}
```

These are module-private functions shared by both `CompositeBuilder` and `SingleChildBuilder`.

**Composite strategy resolution** happens between `parseCompositeArgs` and node construction:

```ts
const { strategy: rawStrategy, context, configureFn } = parseCompositeArgs(optionsOrConfigure, configure);
const strategy = typeof rawStrategy === 'string'
  ? resolveStrategy(this.registry, rawStrategy)
  : rawStrategy;
```

**Note on strategy type safety:** `TreeRegistry.getStrategy()` returns `AnyStrategy` (the union of all three strategy types). Type narrowing is the caller's responsibility — a mismatched strategy type will result in a runtime error when the composite calls `order()` vs `policy()`. This matches the existing behavior when passing strategy objects directly.

### End-to-End Example

```ts
// actions/fetch-user.ts
export const fetchUser: ActionFn = async (ctx) => {
  const user = await getUser(ctx.blackboard.get<string>('userId'));
  ctx.blackboard.set('user', user);
  return NodeStatus.SUCCESS;
};

// conditions/is-authenticated.ts
export const isAuthenticated: ConditionFn = (ctx) => ctx.blackboard.has('authToken');

// registry.ts
import { TreeRegistry } from 'cartographer';
import { fetchUser } from './actions/fetch-user.js';
import { isAuthenticated } from './conditions/is-authenticated.js';

const registry = new TreeRegistry();
registry.registerAction('fetch-user', fetchUser);
registry.registerCondition('is-authenticated', isAuthenticated);
export { registry };

// tree.ts
import { TreeBuilder } from 'cartographer';
import { registry } from './registry.js';

const tree = new TreeBuilder('user-flow', registry)
  .sequence('root', (b) => {
    b.condition('auth-check', 'is-authenticated');
    b.action('load-user', 'fetch-user');
    b.action('inline-step', async (ctx) => {
      // inline functions still work alongside refs
      return NodeStatus.SUCCESS;
    });
  })
  .build();
```

## Files Modified

- `src/builder/tree-builder.ts` — all changes live here
- `src/builder/tree-builder.test.ts` — new test cases for registry-backed builder usage
- `docs/guide-building-trees.md` — add registry + builder section
- `docs/api/config.md` — update TreeRegistry docs to reference builder integration

## Out of Scope

- No changes to `TreeRegistry` itself — its API is sufficient as-is
- No changes to node config types in `src/types.ts` — resolution happens in the builder, not the nodes
- No new exports — `TreeRegistry` and `TreeBuilder` are already exported
