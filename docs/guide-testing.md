# Testing Behavior Trees

This guide covers how to test trees, nodes, and composites effectively using the framework's built-in patterns and test helpers.

---

## Test Contexts

Every node needs a `TreeContext` to tick. The framework provides a minimal context factory in its integration test helpers, and you should follow the same pattern in your own tests:

```typescript
import { InMemoryBlackboard, EventEmitter, NodeStatus } from "cartographer";
import type { TreeContext, TreeEvents } from "cartographer";

function createContext(initial?: Record<string, unknown>): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(initial),
    events: new EventEmitter<TreeEvents>(),
  };
}
```

The `initial` parameter lets you pre-populate the blackboard with test data:

```typescript
const ctx = createContext({ userId: 42, mode: "test" });
```

No abort signal is included in the context by default. If your test needs one, add it manually:

```typescript
const controller = new AbortController();
const ctx = {
  blackboard: new InMemoryBlackboard(),
  events: new EventEmitter<TreeEvents>(),
  signal: controller.signal,
};
```

---

## Testing Nodes in Isolation

The simplest test ticks a single node with a manual context and asserts on the returned status and blackboard state:

```typescript
import { describe, it, expect } from "vitest";
import { ActionNode, NodeStatus, InMemoryBlackboard, EventEmitter } from "cartographer";

describe("MyAction", () => {
  it("writes result to blackboard on success", async () => {
    const node = new ActionNode({
      name: "compute",
      action: (ctx) => {
        ctx.blackboard.set("answer", 42);
        return NodeStatus.SUCCESS;
      },
    });

    const ctx = createContext();
    const status = await node.tick(ctx);

    expect(status).toBe(NodeStatus.SUCCESS);
    expect(ctx.blackboard.get("answer")).toBe(42);
  });

  it("returns FAILURE when precondition is missing", async () => {
    const node = new ActionNode({
      name: "needs-data",
      action: (ctx) => {
        if (!ctx.blackboard.has("input")) return NodeStatus.FAILURE;
        return NodeStatus.SUCCESS;
      },
    });

    const ctx = createContext(); // no 'input' key
    const status = await node.tick(ctx);

    expect(status).toBe(NodeStatus.FAILURE);
  });
});
```

---

## Test Helper Functions

The framework's integration test suite defines several helper functions that make common test patterns concise. You can copy these into your own test utilities.

### `sequentialAction` — Scripted Multi-Status Sequences

Returns an action config that yields a different status on each tick, following a predefined sequence:

```typescript
function sequentialAction(name: string, statuses: NodeStatus[]) {
  let tick = 0;
  return {
    name,
    action: () => {
      const status = statuses[Math.min(tick, statuses.length - 1)];
      tick++;
      return status;
    },
  };
}
```

Use it to simulate children that transition through states:

```typescript
import { ActionNode, SequenceNode, NodeStatus } from "cartographer";

// Child returns RUNNING on first tick, then SUCCESS
const child = new ActionNode(sequentialAction("worker", [NodeStatus.RUNNING, NodeStatus.SUCCESS]));

const ctx = createContext();
expect(await child.tick(ctx)).toBe(NodeStatus.RUNNING);
expect(await child.tick(ctx)).toBe(NodeStatus.SUCCESS);
```

The sequence "sticks" on the last status — if you tick beyond the array length, it keeps returning the final value.

### `countingAction` — Tick-Count Assertions

Returns both an action config and a `getTicks()` function to verify how many times the node was ticked:

```typescript
function countingAction(name: string, statuses: NodeStatus[]) {
  let ticks = 0;
  return {
    config: {
      name,
      action: () => {
        const status = statuses[Math.min(ticks, statuses.length - 1)];
        ticks++;
        return status;
      },
    },
    getTicks: () => ticks,
  };
}
```

This is essential for verifying that composites skip or re-tick children correctly:

```typescript
const a = countingAction("a", [NodeStatus.SUCCESS]);
const b = countingAction("b", [NodeStatus.RUNNING, NodeStatus.SUCCESS]);

const seq = new SequenceNode({
  name: "seq",
  children: [new ActionNode(a.config), new ActionNode(b.config)],
});

const ctx = createContext();

// Tick 1: A succeeds, B returns RUNNING
await seq.tick(ctx);
expect(a.getTicks()).toBe(1);
expect(b.getTicks()).toBe(1);

// Tick 2: sequence re-evaluates from child 0, A uses cached result, B re-ticked
await seq.tick(ctx);
expect(a.getTicks()).toBe(1); // A cached (non-reactive), not re-ticked
expect(b.getTicks()).toBe(2);
```

### `blackboardWriter` — Blackboard Side Effects

Returns an action config that writes a specific key-value pair and returns `SUCCESS`:

```typescript
function blackboardWriter(name: string, key: string, value: unknown) {
  return {
    name,
    action: (ctx: TreeContext) => {
      ctx.blackboard.set(key, value);
      return NodeStatus.SUCCESS;
    },
  };
}
```

Useful for verifying that composites reach specific children:

```typescript
const selector = new SelectorNode({
  name: "fallback",
  children: [
    new ActionNode({ name: "primary", action: () => NodeStatus.FAILURE }),
    new ActionNode(blackboardWriter("fallback", "source", "fallback")),
  ],
});

const ctx = createContext();
await selector.tick(ctx);
expect(ctx.blackboard.get("source")).toBe("fallback");
```

### `slowAction` — Timing Tests

Returns an action config that waits a fixed duration before returning a specific status:

```typescript
function slowAction(name: string, delayMs: number, status: NodeStatus) {
  return {
    name,
    action: () => new Promise<NodeStatus>((resolve) => setTimeout(() => resolve(status), delayMs)),
  };
}
```

Use it to test `Timeout` or timing-sensitive behavior:

```typescript
const timeout = new Timeout({
  name: "timeout",
  child: new ActionNode(slowAction("slow", 200, NodeStatus.SUCCESS)),
  timeoutMs: 100, // deadline is shorter than the action
});

const ctx = createContext();
const status = await timeout.tick(ctx);
expect(status).toBe(NodeStatus.FAILURE); // timed out
```

---

## Event Verification

Use the `collectEvents` pattern to capture events into an array and assert on the sequence after a tick:

```typescript
function collectEvents<K extends keyof TreeEvents & string>(ctx: TreeContext, eventName: K): TreeEvents[K][] {
  const collected: TreeEvents[K][] = [];
  ctx.events.on(eventName, (data) => collected.push(data));
  return collected;
}
```

This lets you verify traversal order, enter/exit pairing, and status reporting:

```typescript
const ctx = createContext();
const enterEvents = collectEvents(ctx, "node:enter");
const exitEvents = collectEvents(ctx, "node:exit");

const selector = new SelectorNode({
  name: "fallback-selector",
  children: [
    new ActionNode({ name: "primary", action: () => NodeStatus.FAILURE }),
    new ActionNode({ name: "secondary", action: () => NodeStatus.FAILURE }),
    new ActionNode(blackboardWriter("fallback", "source", "fallback")),
  ],
});

await selector.tick(ctx);

// Verify traversal order
const enterNames = enterEvents.map((e) => e.node.name);
expect(enterNames).toEqual(["fallback-selector", "primary", "secondary", "fallback"]);

// Children exit before parent
const exitNames = exitEvents.map((e) => e.node.name);
expect(exitNames).toEqual(["primary", "secondary", "fallback", "fallback-selector"]);

// Verify status on each exit
const exitStatuses = exitEvents.map((e) => e.status);
expect(exitStatuses).toEqual([
  NodeStatus.FAILURE, // primary
  NodeStatus.FAILURE, // secondary
  NodeStatus.SUCCESS, // fallback
  NodeStatus.SUCCESS, // selector
]);
```

---

## Abort Tracking

To verify that abort signals propagate correctly through your tree, create a custom node that tracks whether `abort()` was called:

```typescript
import { BaseNode, NodeStatus } from "cartographer";
import type { TreeContext } from "cartographer";

class AbortTrackingNode extends BaseNode {
  aborted = false;

  constructor(
    name: string,
    private status: NodeStatus = NodeStatus.RUNNING,
  ) {
    super(name);
  }

  protected async execute(_context: TreeContext): Promise<NodeStatus> {
    return this.status;
  }

  abort(): void {
    super.abort();
    this.aborted = true;
  }
}
```

Use it to test abort propagation through composites and decorators:

```typescript
const children = [new AbortTrackingNode("child-1"), new AbortTrackingNode("child-2"), new AbortTrackingNode("child-3")];

const parallel = new ParallelNode({ name: "par", children });
const ctx = createContext();

await parallel.tick(ctx);
parallel.abort();

for (const child of children) {
  expect(child.aborted).toBe(true);
}
```

---

## Testing Multi-Tick Workflows

Many trees require multiple ticks to complete — a child returns `RUNNING` and the tree must be ticked again to continue. Test these by calling `tick()` multiple times and asserting on intermediate states:

```typescript
const a = countingAction("a", [NodeStatus.SUCCESS]);
const b = countingAction("b", [NodeStatus.RUNNING, NodeStatus.RUNNING, NodeStatus.SUCCESS]);
const c = countingAction("c", [NodeStatus.SUCCESS]);

const sequence = new SequenceNode({
  name: "seq",
  children: [new ActionNode(a.config), new ActionNode(b.config), new ActionNode(c.config)],
});

const ctx = createContext();

// Tick 1: A=SUCCESS, B=RUNNING → sequence RUNNING
expect(await sequence.tick(ctx)).toBe(NodeStatus.RUNNING);
expect(a.getTicks()).toBe(1);
expect(b.getTicks()).toBe(1);
expect(c.getTicks()).toBe(0); // not reached yet

// Tick 2: re-evaluates from child 0, A cached, B=RUNNING → sequence RUNNING
expect(await sequence.tick(ctx)).toBe(NodeStatus.RUNNING);
expect(a.getTicks()).toBe(1); // cached (non-reactive), not re-ticked
expect(b.getTicks()).toBe(2);

// Tick 3: A cached, B=SUCCESS, C=SUCCESS → sequence SUCCESS
expect(await sequence.tick(ctx)).toBe(NodeStatus.SUCCESS);
expect(b.getTicks()).toBe(3);
expect(c.getTicks()).toBe(1);
```

---

## Testing with ActorServer

For integration tests that exercise the full HTTP stack, create an `ActorServer` on a random port and use the client SDK or fetch directly:

```typescript
import { TreeBuilder, ActorServer, NodeStatus } from "cartographer";

let tickCount = 0;

const server = new ActorServer({
  createTree: () =>
    new TreeBuilder("server-test")
      .action("work", (ctx) => {
        tickCount++;
        if (tickCount < 3) return NodeStatus.RUNNING;
        ctx.blackboard.set("done", true);
        return NodeStatus.SUCCESS;
      })
      .build(),
  port: 0, // random available port
});

const { port } = await server.start();

// Send tick messages programmatically
let result = await server.processMessage({ type: "tick" });
expect(result?.treeStatus).toBe("running");

result = await server.processMessage({ type: "tick" });
expect(result?.treeStatus).toBe("running");

result = await server.processMessage({ type: "tick" });
expect(result?.treeStatus).toBe("success");

await server.stop();
```

---

## Test Organization

Cartographer uses three vitest projects, each targeting a different scope:

| Project       | Location                                | What it tests                                         | Requires            |
| ------------- | --------------------------------------- | ----------------------------------------------------- | ------------------- |
| `unit`        | `src/**/*.test.ts`                      | Individual nodes, composites, decorators in isolation | Nothing             |
| `integration` | `src/__integration__/**/*.test.ts`      | Multi-node workflows, scheduler, abort, events        | Nothing             |
| `live`        | `src/__integration__/live/**/*.test.ts` | Real Claude API calls via AgentNode                   | `ANTHROPIC_API_KEY` |

Run them with:

```bash
pnpm run test             # unit tests across all packages
pnpm run test:integration # integration only (cartographer package)
pnpm run test:live        # live only (requires API key)
pnpm --filter cartographer exec vitest run src/nodes/action.test.ts  # single file
```

### Where to put your tests

- **Unit tests** go next to the source file: `src/nodes/my-node.ts` → `src/nodes/my-node.test.ts`.
- **Integration tests** go in `src/__integration__/` when they exercise multi-node interactions, scheduler behavior, or event flows.
- **Live tests** go in `src/__integration__/live/` when they require a real API key.

---

## Next Steps

- [Error Handling and Resilience](guide-error-handling.md) — Patterns tested in this guide, explained in depth.
- [Advanced Patterns](guide-advanced-patterns.md) — Custom nodes, strategies, and multi-tick resumption internals.
- [Blackboard and Events](guide-blackboard-and-events.md) — Full reference for the blackboard and event APIs.
