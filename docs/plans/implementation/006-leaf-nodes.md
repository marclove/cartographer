# Task 6: Action and Condition Leaf Nodes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the two deterministic leaf node types: ActionNode (runs a user function) and ConditionNode (evaluates a predicate).

**Architecture:** Both extend `BaseNode` and implement `execute()`. ActionNode delegates to a user-provided function. ConditionNode evaluates a predicate and maps `true` → SUCCESS, `false` → FAILURE.

**Tech Stack:** TypeScript

---

### Step 1: Write failing tests for ActionNode

Create `src/nodes/action.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ActionNode } from "./action.js";
import { NodeStatus } from "../types.js";
import type { TreeContext } from "../types.js";
import { EventEmitter } from "../core/event-emitter.js";
import { InMemoryBlackboard } from "../core/blackboard.js";
import type { TreeEvents } from "../types.js";

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

describe("ActionNode", () => {
  it("returns the status from the action function", async () => {
    const node = new ActionNode({
      name: "test-action",
      action: () => NodeStatus.SUCCESS,
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it("supports async action functions", async () => {
    const node = new ActionNode({
      name: "async-action",
      action: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return NodeStatus.FAILURE;
      },
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it("passes TreeContext to the action function", async () => {
    const actionFn = vi.fn(() => NodeStatus.SUCCESS);
    const node = new ActionNode({ name: "ctx-action", action: actionFn });
    const ctx = createContext();
    ctx.blackboard.set("key", "value");

    await node.tick(ctx);

    expect(actionFn).toHaveBeenCalledWith(ctx);
  });

  it("returns FAILURE when action throws", async () => {
    const node = new ActionNode({
      name: "error-action",
      action: () => {
        throw new Error("boom");
      },
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it("can return RUNNING status", async () => {
    const node = new ActionNode({
      name: "running-action",
      action: () => NodeStatus.RUNNING,
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/nodes/action.test.ts`
Expected: FAIL — cannot import `ActionNode`

### Step 3: Implement ActionNode

Create `src/nodes/action.ts`:

```typescript
import { BaseNode } from "./base.js";
import type { ActionNodeConfig, TreeContext } from "../types.js";
import type { NodeStatus } from "../types.js";

export class ActionNode extends BaseNode {
  private action: ActionNodeConfig["action"];

  constructor(config: ActionNodeConfig) {
    super(config.name);
    this.action = config.action;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    return await this.action(context);
  }
}
```

### Step 4: Run test to verify it passes

Run: `npx vitest run src/nodes/action.test.ts`
Expected: PASS (all 5 tests)

### Step 5: Write failing tests for ConditionNode

Create `src/nodes/condition.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ConditionNode } from "./condition.js";
import { NodeStatus } from "../types.js";
import type { TreeContext } from "../types.js";
import { EventEmitter } from "../core/event-emitter.js";
import { InMemoryBlackboard } from "../core/blackboard.js";
import type { TreeEvents } from "../types.js";

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

describe("ConditionNode", () => {
  it("returns SUCCESS when condition is true", async () => {
    const node = new ConditionNode({
      name: "true-cond",
      condition: () => true,
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it("returns FAILURE when condition is false", async () => {
    const node = new ConditionNode({
      name: "false-cond",
      condition: () => false,
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it("supports async conditions", async () => {
    const node = new ConditionNode({
      name: "async-cond",
      condition: async () => true,
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it("passes TreeContext to the condition", async () => {
    const condFn = vi.fn(() => true);
    const node = new ConditionNode({ name: "ctx-cond", condition: condFn });
    const ctx = createContext();

    await node.tick(ctx);

    expect(condFn).toHaveBeenCalledWith(ctx);
  });

  it("returns FAILURE when condition throws", async () => {
    const node = new ConditionNode({
      name: "error-cond",
      condition: () => {
        throw new Error("boom");
      },
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it("reads from blackboard in condition", async () => {
    const node = new ConditionNode({
      name: "bb-cond",
      condition: (ctx) => ctx.blackboard.get<number>("health")! > 50,
    });

    const ctx = createContext();
    ctx.blackboard.set("health", 80);
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);

    ctx.blackboard.set("health", 20);
    expect(await node.tick(ctx)).toBe(NodeStatus.FAILURE);
  });
});
```

### Step 6: Run test to verify it fails

Run: `npx vitest run src/nodes/condition.test.ts`
Expected: FAIL — cannot import `ConditionNode`

### Step 7: Implement ConditionNode

Create `src/nodes/condition.ts`:

```typescript
import { BaseNode } from "./base.js";
import { NodeStatus } from "../types.js";
import type { ConditionNodeConfig, TreeContext } from "../types.js";

export class ConditionNode extends BaseNode {
  private condition: ConditionNodeConfig["condition"];

  constructor(config: ConditionNodeConfig) {
    super(config.name);
    this.condition = config.condition;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const result = await this.condition(context);
    return result ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}
```

### Step 8: Run test to verify it passes

Run: `npx vitest run src/nodes/condition.test.ts`
Expected: PASS (all 6 tests)

### Step 9: Commit

```bash
git add src/nodes/action.ts src/nodes/action.test.ts src/nodes/condition.ts src/nodes/condition.test.ts
git commit -m "feat: implement ActionNode and ConditionNode leaf nodes"
```
