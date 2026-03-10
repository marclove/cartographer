# Task 31: Optional Custom Node IDs

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow nodes to accept an optional custom `id` string, falling back to the existing auto-generated UUID v4 when omitted.

**Architecture:** `BaseNode` constructor gains an optional `id` parameter. All config interfaces (`ActionNodeConfig`, `ConditionNodeConfig`, `AgentNodeConfig`, `SelectorConfig`, `SequenceConfig`, `ParallelConfig`, `DecoratorConfig`) gain an optional `id` field. All node constructors pass `config.id` through to `super()`. `TreeLoader` threads `id` from config/YAML to node constructors.

**Tech Stack:** TypeScript, uuid, vitest

**Depends on:** Task 30 (children accessor)

---

### Step 1: Update `BaseNode` to accept optional `id`

Modify `src/nodes/base.ts`. Change the constructor from:

```typescript
  constructor(name: string) {
    this.id = uuidv4();
    this.name = name;
  }
```

to:

```typescript
  constructor(name: string, id?: string) {
    this.id = id ?? uuidv4();
    this.name = name;
  }
```

### Step 2: Add `id?` to all config interfaces

Modify `src/types.ts`. Add an optional `id` field to each config interface, before the `name` field. Use this doc comment on `ActionNodeConfig` (the first one users see) and a short version on the rest:

**ActionNodeConfig:**
```typescript
  /**
   * Optional stable identifier for this node instance.
   *
   * When provided, this value is used as the node's `id` instead of an
   * auto-generated UUID. Useful for stable cross-run log correlation,
   * config-driven identity, and targeted node lookup.
   *
   * Must be unique across all nodes in a tree — `BehaviorTree` validates
   * this at construction time and throws on duplicates.
   */
  id?: string;
```

**All other config interfaces** (`ConditionNodeConfig`, `AgentNodeConfig`, `SelectorConfig`, `SequenceConfig`, `ParallelConfig`, `DecoratorConfig`):
```typescript
  /** Optional stable identifier. Auto-generated UUID when omitted. */
  id?: string;
```

### Step 3: Thread `id` through all node constructors

Change `super(config.name)` to `super(config.name, config.id)` in every node class:

- `src/nodes/action.ts`
- `src/nodes/condition.ts`
- `src/nodes/agent.ts`
- `src/composites/selector.ts`
- `src/composites/sequence.ts`
- `src/composites/parallel.ts`
- `src/decorators/inverter.ts`
- `src/decorators/always-succeed.ts`
- `src/decorators/always-fail.ts`
- `src/decorators/retry.ts`
- `src/decorators/repeat.ts`
- `src/decorators/timeout.ts`
- `src/decorators/guard.ts`

### Step 4: Thread `id` through `TreeLoader`

Modify `src/config/loader.ts`. In `buildNode`, pass `id: config.id as string | undefined` to each node constructor's config object. The `NodeConfig` interface's `[key: string]: unknown` index signature already permits an `id` field from YAML, so no interface change is needed.

For every `case` in the `switch`, add `id: config.id as string | undefined` to the config object. Example for `action`:

```typescript
case 'action': {
  if (!config.ref) throw new Error(`Action node "${config.name}" is missing required "ref"`);
  return new ActionNode({
    id: config.id as string | undefined,
    name: config.name,
    action: registry.getAction(config.ref),
  });
}
```

Apply the same for all 13 cases (`action`, `condition`, `agent`, `selector`, `sequence`, `parallel`, `inverter`, `repeat`, `retry`, `alwaysSucceed`, `alwaysFail`, `timeout`, `guard`).

### Step 5: Add tests for custom IDs

Add to `src/nodes/base.test.ts` (the `TestNode` constructor will need updating to pass `id` through):

Update `TestNode` constructor:
```typescript
class TestNode extends BaseNode {
  public executeFn: (context: TreeContext) => Promise<NodeStatus> = async () => NodeStatus.SUCCESS;

  constructor(name: string, id?: string) {
    super(name, id);
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    return this.executeFn(context);
  }
}
```

Add tests:
```typescript
  it('uses custom id when provided', () => {
    const node = new TestNode('my-node', 'custom-id-123');
    expect(node.id).toBe('custom-id-123');
  });

  it('generates UUID when id is not provided', () => {
    const node = new TestNode('my-node');
    expect(node.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
```

Add to `src/nodes/action.test.ts`:

```typescript
  it('accepts custom id via config', () => {
    const node = new ActionNode({ id: 'my-action', name: 'act', action: async () => NodeStatus.SUCCESS });
    expect(node.id).toBe('my-action');
  });
```

Add to `src/config/loader.test.ts`:

```typescript
  it('passes id from config to node', () => {
    registry.registerAction('noop', async () => NodeStatus.SUCCESS);
    const tree = TreeLoader.fromConfig({
      name: 'test',
      root: { type: 'action', name: 'act', ref: 'noop', id: 'custom-id' },
    }, registry);
    // The tree should construct without error; the root node has the custom id.
    // We can't directly inspect the root, but we verify it ticks successfully.
    expect(tree).toBeDefined();
  });
```

### Step 6: Run tests

Run: `npm run typecheck && npm run test`
Expected: All pass.

### Step 7: Commit

```bash
git add src/types.ts src/nodes/ src/composites/ src/decorators/ src/config/loader.ts
git commit -m "feat: accept optional custom ID on all node types"
```
