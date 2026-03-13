# Task 35: Context Layering in BaseNode

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `contextOverrides` mechanism to `BaseNode` so that any node can override `TreeContext` fields for itself and its descendants. This is the foundation for per-subtree elicitation handlers and future context-scoped features.

**Important constraint:** The `events` and `blackboard` fields on `TreeContext` must **never** be overridable via context overrides. The tree-level event emitter is the single source of truth for observability — all nodes must emit to the same emitter. The tree-level blackboard is the single shared data store — per-subtree blackboard _scoping_ (via `ScopedBlackboard`) is a future feature that requires a different mechanism (a transform derived from the incoming context, not a static replacement). The merge logic must explicitly preserve both `events` and `blackboard` from the incoming context.

**Depends on:** None

---

### Step 1: Write failing tests

Add new tests to `src/nodes/base.test.ts`:

```typescript
describe("contextOverrides", () => {
  it("merges contextOverrides onto the context passed to execute()", async () => {
    const node = new TestNode("node");
    const context = createContext();
    const handler = vi.fn();
    node.setContextOverrides({ onElicitation: handler } as Partial<TreeContext>);

    let receivedContext: TreeContext | undefined;
    node.executeFn = async (ctx) => {
      receivedContext = ctx;
      return NodeStatus.SUCCESS;
    };

    await node.tick(context);

    expect(receivedContext!.onElicitation).toBe(handler);
    expect(receivedContext!.events).toBe(context.events);
    expect(receivedContext!.blackboard).toBe(context.blackboard);
  });

  it("passes the original context when no overrides are set", async () => {
    const node = new TestNode("node");
    const context = createContext();

    let receivedContext: TreeContext | undefined;
    node.executeFn = async (ctx) => {
      receivedContext = ctx;
      return NodeStatus.SUCCESS;
    };

    await node.tick(context);

    expect(receivedContext!.blackboard).toBe(context.blackboard);
    expect(receivedContext!.events).toBe(context.events);
  });

  it("always preserves the original events emitter even when overrides include events", async () => {
    const node = new TestNode("node");
    const context = createContext();
    const otherEvents = new EventEmitter<TreeEvents>();
    node.setContextOverrides({ events: otherEvents } as Partial<TreeContext>);

    const originalSpy = vi.fn();
    const otherSpy = vi.fn();
    context.events.on("node:enter", originalSpy);
    otherEvents.on("node:enter", otherSpy);

    await node.tick(context);

    // events is never overridden — all events go to the tree-level emitter
    expect(originalSpy).toHaveBeenCalledOnce();
    expect(otherSpy).not.toHaveBeenCalled();
  });

  it("always preserves the original blackboard even when overrides include blackboard", async () => {
    const node = new TestNode("node");
    const context = createContext();
    const otherBlackboard = new InMemoryBlackboard();
    node.setContextOverrides({ blackboard: otherBlackboard } as Partial<TreeContext>);

    let receivedContext: TreeContext | undefined;
    node.executeFn = async (ctx) => {
      receivedContext = ctx;
      return NodeStatus.SUCCESS;
    };

    await node.tick(context);

    // blackboard is never overridden — the tree-level blackboard is always used
    expect(receivedContext!.blackboard).toBe(context.blackboard);
    expect(receivedContext!.blackboard).not.toBe(otherBlackboard);
  });

  it("mergeContextOverrides adds to existing overrides", async () => {
    const node = new TestNode("node");
    const context = createContext();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    node.setContextOverrides({ onElicitation: handler1 } as Partial<TreeContext>);
    node.mergeContextOverrides({ onElicitation: handler2 } as Partial<TreeContext>);

    let receivedContext: TreeContext | undefined;
    node.executeFn = async (ctx) => {
      receivedContext = ctx;
      return NodeStatus.SUCCESS;
    };

    await node.tick(context);

    // mergeContextOverrides overwrites existing keys
    expect(receivedContext!.onElicitation).toBe(handler2);
  });
});
```

The `TestNode` class at the top of the file needs public methods to set overrides:

```typescript
class TestNode extends BaseNode {
  // ... existing code ...

  setContextOverrides(overrides: Partial<TreeContext>): void {
    this.contextOverrides = overrides;
  }

  mergeContextOverrides(overrides: Partial<TreeContext>): void {
    this.contextOverrides = { ...this.contextOverrides, ...overrides };
  }
}
```

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/nodes/base.test.ts`
Expected: FAIL — `contextOverrides` does not exist on `BaseNode`.

### Step 3: Implement context layering in BaseNode

Edit `src/nodes/base.ts`:

1. Add a protected `contextOverrides` field and public methods:

```typescript
protected contextOverrides?: Partial<TreeContext>;

/**
 * Set context overrides for this node and its descendants.
 * Fields set here will be shallow-merged onto the incoming TreeContext
 * before this node's execute() and before passing context to children.
 *
 * Note: `events` and `blackboard` are never overridable. The tree-level
 * event emitter is always preserved to guarantee a single observability
 * point. The tree-level blackboard is always preserved as the single
 * shared data store (per-subtree scoping is a future feature requiring
 * a different mechanism).
 */
setContextOverrides(overrides: Partial<TreeContext>): void {
  this.contextOverrides = overrides;
}

/**
 * Merge additional context overrides onto any existing overrides.
 */
mergeContextOverrides(overrides: Partial<TreeContext>): void {
  this.contextOverrides = { ...this.contextOverrides, ...overrides };
}
```

2. Modify `tick()` to merge overrides before all other logic, always preserving `events`:

```typescript
async tick(context: TreeContext): Promise<NodeStatus> {
  const effectiveContext = this.contextOverrides
    ? { ...context, ...this.contextOverrides, events: context.events, blackboard: context.blackboard }
    : context;

  effectiveContext.events.emit('node:enter', { node: this, context: effectiveContext });
  const start = performance.now();

  try {
    const status = await this.execute(effectiveContext);
    const durationMs = performance.now() - start;
    effectiveContext.events.emit('node:exit', { node: this, status, context: effectiveContext, durationMs });
    return status;
  } catch (error) {
    const durationMs = performance.now() - start;
    effectiveContext.events.emit('node:error', { node: this, error: error as Error, context: effectiveContext });
    effectiveContext.events.emit('node:exit', {
      node: this,
      status: NodeStatus.FAILURE,
      context: effectiveContext,
      durationMs,
    });
    return NodeStatus.FAILURE;
  }
}
```

The pinned fields `events: context.events` and `blackboard: context.blackboard` always win over any override, ensuring a single event emitter and single shared blackboard for the entire tree.

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/nodes/base.test.ts`
Expected: PASS (all tests including new ones)

### Step 5: Run full test suite

Run: `npm run typecheck && npm run test`
Expected: All pass — existing behavior is unchanged when `contextOverrides` is not set.

### Step 6: Commit

```bash
git add src/nodes/base.ts src/nodes/base.test.ts
git commit -m "feat: add context layering to BaseNode via contextOverrides"
```
