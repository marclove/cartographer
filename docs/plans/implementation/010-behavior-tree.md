# Task 10: BehaviorTree Runner

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the `BehaviorTree` class that wraps a root node, creates the TreeContext, and provides `tick()`, `run()`, `abort()`, and `reset()`.

**Architecture:** `BehaviorTree` is the top-level container. It owns the blackboard and event emitter, constructs the `TreeContext`, and delegates `tick()` to the root node.

**Tech Stack:** TypeScript

---

### Step 1: Write failing tests

Create `src/core/behavior-tree.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { BehaviorTree } from "./behavior-tree.js";
import { NodeStatus } from "../types.js";
import { ActionNode } from "../nodes/action.js";
import { SequenceNode } from "../composites/sequence.js";
import { InMemoryBlackboard } from "./blackboard.js";

describe("BehaviorTree", () => {
  it("tick() returns the root node status", async () => {
    const tree = new BehaviorTree({
      name: "test-tree",
      root: new ActionNode({ name: "root", action: () => NodeStatus.SUCCESS }),
    });

    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it("tick() returns FAILURE when root fails", async () => {
    const tree = new BehaviorTree({
      name: "test-tree",
      root: new ActionNode({ name: "root", action: () => NodeStatus.FAILURE }),
    });

    expect(await tree.tick()).toBe(NodeStatus.FAILURE);
  });

  it("provides a default blackboard", () => {
    const tree = new BehaviorTree({
      name: "test-tree",
      root: new ActionNode({ name: "root", action: () => NodeStatus.SUCCESS }),
    });

    expect(tree.blackboard).toBeDefined();
    tree.blackboard.set("key", "value");
    expect(tree.blackboard.get("key")).toBe("value");
  });

  it("accepts a pre-populated blackboard", async () => {
    const bb = new InMemoryBlackboard({ initial: 42 });
    const tree = new BehaviorTree({
      name: "test-tree",
      root: new ActionNode({
        name: "root",
        action: (ctx) => {
          return ctx.blackboard.get<number>("initial") === 42 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
        },
      }),
      blackboard: bb,
    });

    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });

  it("run() returns status and blackboard snapshot", async () => {
    const tree = new BehaviorTree({
      name: "test-tree",
      root: new ActionNode({
        name: "root",
        action: (ctx) => {
          ctx.blackboard.set("result", "done");
          return NodeStatus.SUCCESS;
        },
      }),
    });

    const result = await tree.run();

    expect(result.status).toBe(NodeStatus.SUCCESS);
    expect(result.blackboard.result).toBe("done");
  });

  it("events emitter is accessible", async () => {
    const tree = new BehaviorTree({
      name: "test-tree",
      root: new ActionNode({ name: "root", action: () => NodeStatus.SUCCESS }),
    });

    const enterSpy = vi.fn();
    tree.events.on("node:enter", enterSpy);
    await tree.tick();

    expect(enterSpy).toHaveBeenCalled();
  });

  it("reset() resets the root node", () => {
    const resetSpy = vi.fn();
    const root = new ActionNode({ name: "root", action: () => NodeStatus.SUCCESS });
    // Patch reset for testing
    root.reset = resetSpy;

    const tree = new BehaviorTree({ name: "test-tree", root });
    tree.reset();

    expect(resetSpy).toHaveBeenCalled();
  });

  it("abort() aborts the root node", () => {
    const abortSpy = vi.fn();
    const root = new ActionNode({ name: "root", action: () => NodeStatus.SUCCESS });
    root.abort = abortSpy;

    const tree = new BehaviorTree({ name: "test-tree", root });
    tree.abort();

    expect(abortSpy).toHaveBeenCalled();
  });

  it("nodes share the same blackboard through context", async () => {
    const tree = new BehaviorTree({
      name: "test-tree",
      root: new SequenceNode({
        name: "seq",
        children: [
          new ActionNode({
            name: "writer",
            action: (ctx) => {
              ctx.blackboard.set("shared", "hello");
              return NodeStatus.SUCCESS;
            },
          }),
          new ActionNode({
            name: "reader",
            action: (ctx) => {
              return ctx.blackboard.get("shared") === "hello" ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
            },
          }),
        ],
      }),
    });

    expect(await tree.tick()).toBe(NodeStatus.SUCCESS);
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/core/behavior-tree.test.ts`
Expected: FAIL

### Step 3: Implement BehaviorTree

Create `src/core/behavior-tree.ts`:

```typescript
import { NodeStatus } from "../types.js";
import type { BehaviorTreeConfig, BTreeNode, Blackboard, TreeContext, TreeEvents } from "../types.js";
import { EventEmitter } from "./event-emitter.js";
import { InMemoryBlackboard } from "./blackboard.js";

export class BehaviorTree {
  readonly name: string;
  readonly blackboard: Blackboard & { toRecord?(): Record<string, unknown> };
  readonly events: EventEmitter<TreeEvents>;

  private root: BTreeNode;
  private abortController: AbortController;

  constructor(config: BehaviorTreeConfig) {
    this.name = config.name;
    this.root = config.root;
    this.blackboard = config.blackboard ?? new InMemoryBlackboard();
    this.events = new EventEmitter<TreeEvents>();
    this.abortController = new AbortController();
  }

  async tick(): Promise<NodeStatus> {
    const context: TreeContext = {
      blackboard: this.blackboard,
      events: this.events,
      signal: this.abortController.signal,
    };

    return this.root.tick(context);
  }

  async run(): Promise<{ status: NodeStatus; blackboard: Record<string, unknown> }> {
    const status = await this.tick();
    const snapshot =
      "toRecord" in this.blackboard && typeof this.blackboard.toRecord === "function" ? this.blackboard.toRecord() : {};
    return { status, blackboard: snapshot };
  }

  reset(): void {
    this.root.reset();
    this.abortController = new AbortController();
  }

  abort(): void {
    this.root.abort();
    this.abortController.abort();
  }
}
```

### Step 4: Run test to verify it passes

Run: `npx vitest run src/core/behavior-tree.test.ts`
Expected: PASS (all 9 tests)

### Step 5: Commit

```bash
git add src/core/behavior-tree.ts src/core/behavior-tree.test.ts
git commit -m "feat: implement BehaviorTree runner with tick, run, abort, and reset"
```
