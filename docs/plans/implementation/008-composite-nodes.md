# Task 8: Composite Nodes (Selector, Sequence, Parallel)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the three composite node types, each delegating core logic to its strategy.

**Architecture:** Each composite extends `BaseNode`. The `execute()` method calls the strategy, then applies the composite's specific tick logic on the ordered/configured children.

**Tech Stack:** TypeScript

---

### Step 1: Write failing tests for SelectorNode

Create `src/composites/selector.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { SelectorNode } from "./selector.js";
import { NodeStatus } from "../types.js";
import type { BTreeNode, TreeContext, SelectionStrategy } from "../types.js";
import { EventEmitter } from "../core/event-emitter.js";
import { InMemoryBlackboard } from "../core/blackboard.js";
import type { TreeEvents } from "../types.js";
import { ActionNode } from "../nodes/action.js";

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

function actionNode(name: string, status: NodeStatus): ActionNode {
  return new ActionNode({ name, action: () => status });
}

describe("SelectorNode", () => {
  it("returns SUCCESS when first child succeeds", async () => {
    const node = new SelectorNode({
      name: "sel",
      children: [actionNode("a", NodeStatus.SUCCESS), actionNode("b", NodeStatus.FAILURE)],
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it("returns SUCCESS when second child succeeds after first fails", async () => {
    const node = new SelectorNode({
      name: "sel",
      children: [actionNode("a", NodeStatus.FAILURE), actionNode("b", NodeStatus.SUCCESS)],
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it("returns FAILURE when all children fail", async () => {
    const node = new SelectorNode({
      name: "sel",
      children: [actionNode("a", NodeStatus.FAILURE), actionNode("b", NodeStatus.FAILURE)],
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it("returns RUNNING when a child returns RUNNING", async () => {
    const node = new SelectorNode({
      name: "sel",
      children: [actionNode("a", NodeStatus.FAILURE), actionNode("b", NodeStatus.RUNNING)],
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });

  it("does not tick children after SUCCESS", async () => {
    const tickSpy = vi.fn(async () => NodeStatus.FAILURE);
    const secondChild: BTreeNode = {
      id: "2",
      name: "b",
      tick: tickSpy,
      reset: () => {},
      abort: () => {},
    };

    const node = new SelectorNode({
      name: "sel",
      children: [actionNode("a", NodeStatus.SUCCESS), secondChild],
    });

    await node.tick(createContext());
    expect(tickSpy).not.toHaveBeenCalled();
  });

  it("uses a custom strategy to reorder children", async () => {
    const reverseStrategy: SelectionStrategy = {
      order: async (children) => [...children].reverse(),
    };

    const order: string[] = [];
    const trackingNode = (name: string, status: NodeStatus): BTreeNode => ({
      id: name,
      name,
      tick: async () => {
        order.push(name);
        return status;
      },
      reset: () => {},
      abort: () => {},
    });

    const node = new SelectorNode({
      name: "sel",
      children: [trackingNode("a", NodeStatus.FAILURE), trackingNode("b", NodeStatus.FAILURE)],
      strategy: reverseStrategy,
    });

    await node.tick(createContext());
    expect(order).toEqual(["b", "a"]);
  });

  it("resets all children on reset()", () => {
    const resetSpy1 = vi.fn();
    const resetSpy2 = vi.fn();
    const child1: BTreeNode = {
      id: "1",
      name: "a",
      tick: async () => NodeStatus.SUCCESS,
      reset: resetSpy1,
      abort: () => {},
    };
    const child2: BTreeNode = {
      id: "2",
      name: "b",
      tick: async () => NodeStatus.SUCCESS,
      reset: resetSpy2,
      abort: () => {},
    };

    const node = new SelectorNode({ name: "sel", children: [child1, child2] });
    node.reset();

    expect(resetSpy1).toHaveBeenCalled();
    expect(resetSpy2).toHaveBeenCalled();
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/composites/selector.test.ts`
Expected: FAIL

### Step 3: Implement SelectorNode

Create `src/composites/selector.ts`:

```typescript
import { BaseNode } from "../nodes/base.js";
import { NodeStatus } from "../types.js";
import type { SelectorConfig, TreeContext, SelectionStrategy } from "../types.js";
import { DefaultSelectionStrategy } from "../strategies/default-selection.js";

export class SelectorNode extends BaseNode {
  private children: SelectorConfig["children"];
  private strategy: SelectionStrategy;

  constructor(config: SelectorConfig) {
    super(config.name);
    this.children = config.children;
    this.strategy = config.strategy ?? new DefaultSelectionStrategy();
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const ordered = await this.strategy.order(this.children, context);

    for (const child of ordered) {
      const status = await child.tick(context);
      if (status === NodeStatus.SUCCESS || status === NodeStatus.RUNNING) {
        return status;
      }
    }

    return NodeStatus.FAILURE;
  }

  reset(): void {
    for (const child of this.children) {
      child.reset();
    }
  }

  abort(): void {
    for (const child of this.children) {
      child.abort();
    }
  }
}
```

### Step 4: Run test to verify it passes

Run: `npx vitest run src/composites/selector.test.ts`
Expected: PASS (all 7 tests)

### Step 5: Write failing tests for SequenceNode

Create `src/composites/sequence.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { SequenceNode } from "./sequence.js";
import { NodeStatus } from "../types.js";
import type { BTreeNode, TreeContext, ExecutionStrategy } from "../types.js";
import { EventEmitter } from "../core/event-emitter.js";
import { InMemoryBlackboard } from "../core/blackboard.js";
import type { TreeEvents } from "../types.js";
import { ActionNode } from "../nodes/action.js";

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

function actionNode(name: string, status: NodeStatus): ActionNode {
  return new ActionNode({ name, action: () => status });
}

describe("SequenceNode", () => {
  it("returns SUCCESS when all children succeed", async () => {
    const node = new SequenceNode({
      name: "seq",
      children: [actionNode("a", NodeStatus.SUCCESS), actionNode("b", NodeStatus.SUCCESS)],
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it("returns FAILURE when first child fails", async () => {
    const node = new SequenceNode({
      name: "seq",
      children: [actionNode("a", NodeStatus.FAILURE), actionNode("b", NodeStatus.SUCCESS)],
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it("returns FAILURE when second child fails", async () => {
    const node = new SequenceNode({
      name: "seq",
      children: [actionNode("a", NodeStatus.SUCCESS), actionNode("b", NodeStatus.FAILURE)],
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it("returns RUNNING when a child returns RUNNING", async () => {
    const node = new SequenceNode({
      name: "seq",
      children: [actionNode("a", NodeStatus.SUCCESS), actionNode("b", NodeStatus.RUNNING)],
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });

  it("does not tick children after FAILURE", async () => {
    const tickSpy = vi.fn(async () => NodeStatus.SUCCESS);
    const secondChild: BTreeNode = {
      id: "2",
      name: "b",
      tick: tickSpy,
      reset: () => {},
      abort: () => {},
    };

    const node = new SequenceNode({
      name: "seq",
      children: [actionNode("a", NodeStatus.FAILURE), secondChild],
    });

    await node.tick(createContext());
    expect(tickSpy).not.toHaveBeenCalled();
  });

  it("uses a custom strategy to reorder children", async () => {
    const reverseStrategy: ExecutionStrategy = {
      order: async (children) => [...children].reverse(),
    };

    const order: string[] = [];
    const trackingNode = (name: string): BTreeNode => ({
      id: name,
      name,
      tick: async () => {
        order.push(name);
        return NodeStatus.SUCCESS;
      },
      reset: () => {},
      abort: () => {},
    });

    const node = new SequenceNode({
      name: "seq",
      children: [trackingNode("a"), trackingNode("b")],
      strategy: reverseStrategy,
    });

    await node.tick(createContext());
    expect(order).toEqual(["b", "a"]);
  });
});
```

### Step 6: Run test to verify it fails

Run: `npx vitest run src/composites/sequence.test.ts`
Expected: FAIL

### Step 7: Implement SequenceNode

Create `src/composites/sequence.ts`:

```typescript
import { BaseNode } from "../nodes/base.js";
import { NodeStatus } from "../types.js";
import type { SequenceConfig, TreeContext, ExecutionStrategy } from "../types.js";
import { DefaultExecutionStrategy } from "../strategies/default-execution.js";

export class SequenceNode extends BaseNode {
  private children: SequenceConfig["children"];
  private strategy: ExecutionStrategy;

  constructor(config: SequenceConfig) {
    super(config.name);
    this.children = config.children;
    this.strategy = config.strategy ?? new DefaultExecutionStrategy();
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const ordered = await this.strategy.order(this.children, context);

    for (const child of ordered) {
      const status = await child.tick(context);
      if (status === NodeStatus.FAILURE || status === NodeStatus.RUNNING) {
        return status;
      }
    }

    return NodeStatus.SUCCESS;
  }

  reset(): void {
    for (const child of this.children) {
      child.reset();
    }
  }

  abort(): void {
    for (const child of this.children) {
      child.abort();
    }
  }
}
```

### Step 8: Run test to verify it passes

Run: `npx vitest run src/composites/sequence.test.ts`
Expected: PASS (all 6 tests)

### Step 9: Write failing tests for ParallelNode

Create `src/composites/parallel.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { ParallelNode } from "./parallel.js";
import { NodeStatus } from "../types.js";
import type { TreeContext, ParallelStrategy, ParallelPolicy, BTreeNode } from "../types.js";
import { EventEmitter } from "../core/event-emitter.js";
import { InMemoryBlackboard } from "../core/blackboard.js";
import type { TreeEvents } from "../types.js";
import { ActionNode } from "../nodes/action.js";
import { DefaultParallelStrategy } from "../strategies/default-parallel.js";

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

function actionNode(name: string, status: NodeStatus): ActionNode {
  return new ActionNode({ name, action: () => status });
}

describe("ParallelNode", () => {
  it("returns SUCCESS when all children succeed (default policy)", async () => {
    const node = new ParallelNode({
      name: "par",
      children: [actionNode("a", NodeStatus.SUCCESS), actionNode("b", NodeStatus.SUCCESS)],
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it("returns FAILURE when any child fails (default policy requires all)", async () => {
    const node = new ParallelNode({
      name: "par",
      children: [actionNode("a", NodeStatus.SUCCESS), actionNode("b", NodeStatus.FAILURE)],
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it("returns SUCCESS when successCount threshold is met", async () => {
    const node = new ParallelNode({
      name: "par",
      children: [
        actionNode("a", NodeStatus.SUCCESS),
        actionNode("b", NodeStatus.FAILURE),
        actionNode("c", NodeStatus.SUCCESS),
      ],
      strategy: new DefaultParallelStrategy({ successCount: 2 }),
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it("returns FAILURE when failureCount threshold is met", async () => {
    const node = new ParallelNode({
      name: "par",
      children: [
        actionNode("a", NodeStatus.FAILURE),
        actionNode("b", NodeStatus.FAILURE),
        actionNode("c", NodeStatus.SUCCESS),
      ],
      strategy: new DefaultParallelStrategy({ failureCount: 2 }),
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it("returns SUCCESS when successPercentage threshold is met", async () => {
    const node = new ParallelNode({
      name: "par",
      children: [
        actionNode("a", NodeStatus.SUCCESS),
        actionNode("b", NodeStatus.FAILURE),
        actionNode("c", NodeStatus.SUCCESS),
        actionNode("d", NodeStatus.SUCCESS),
      ],
      strategy: new DefaultParallelStrategy({ successPercentage: 50 }),
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it("returns RUNNING when any child returns RUNNING", async () => {
    const node = new ParallelNode({
      name: "par",
      children: [actionNode("a", NodeStatus.SUCCESS), actionNode("b", NodeStatus.RUNNING)],
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });

  it("ticks all children concurrently", async () => {
    const order: string[] = [];
    const delayNode = (name: string, ms: number): BTreeNode => ({
      id: name,
      name,
      tick: async () => {
        await new Promise((r) => setTimeout(r, ms));
        order.push(name);
        return NodeStatus.SUCCESS;
      },
      reset: () => {},
      abort: () => {},
    });

    const node = new ParallelNode({
      name: "par",
      children: [delayNode("slow", 20), delayNode("fast", 5)],
    });

    await node.tick(createContext());
    // fast should finish before slow due to concurrent execution
    expect(order).toEqual(["fast", "slow"]);
  });

  it("uses a custom strategy for policy", async () => {
    const customStrategy: ParallelStrategy = {
      policy: async () => ({ successCount: 1 }),
    };

    const node = new ParallelNode({
      name: "par",
      children: [actionNode("a", NodeStatus.SUCCESS), actionNode("b", NodeStatus.FAILURE)],
      strategy: customStrategy,
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });
});
```

### Step 10: Run test to verify it fails

Run: `npx vitest run src/composites/parallel.test.ts`
Expected: FAIL

### Step 11: Implement ParallelNode

Create `src/composites/parallel.ts`:

```typescript
import { BaseNode } from "../nodes/base.js";
import { NodeStatus } from "../types.js";
import type { ParallelConfig, TreeContext, ParallelStrategy } from "../types.js";
import { DefaultParallelStrategy } from "../strategies/default-parallel.js";

export class ParallelNode extends BaseNode {
  private children: ParallelConfig["children"];
  private strategy: ParallelStrategy;

  constructor(config: ParallelConfig) {
    super(config.name);
    this.children = config.children;
    this.strategy = config.strategy ?? new DefaultParallelStrategy();
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const policy = await this.strategy.policy(this.children, context);
    const results = await Promise.all(this.children.map((child) => child.tick(context)));

    // Check for RUNNING first
    if (results.includes(NodeStatus.RUNNING)) {
      return NodeStatus.RUNNING;
    }

    const successCount = results.filter((r) => r === NodeStatus.SUCCESS).length;
    const failureCount = results.filter((r) => r === NodeStatus.FAILURE).length;

    // Check failure threshold first
    if (policy.failureCount !== undefined && failureCount >= policy.failureCount) {
      return NodeStatus.FAILURE;
    }

    // Check success by percentage
    if (policy.successPercentage !== undefined) {
      const percentage = (successCount / results.length) * 100;
      return percentage >= policy.successPercentage ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
    }

    // Check success by count (default)
    if (policy.successCount !== undefined) {
      return successCount >= policy.successCount ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
    }

    // Fallback: require all to succeed
    return failureCount === 0 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }

  reset(): void {
    for (const child of this.children) {
      child.reset();
    }
  }

  abort(): void {
    for (const child of this.children) {
      child.abort();
    }
  }
}
```

### Step 12: Run test to verify it passes

Run: `npx vitest run src/composites/parallel.test.ts`
Expected: PASS (all 8 tests)

### Step 13: Commit

```bash
git add src/composites/selector.ts src/composites/selector.test.ts src/composites/sequence.ts src/composites/sequence.test.ts src/composites/parallel.ts src/composites/parallel.test.ts
git commit -m "feat: implement Selector, Sequence, and Parallel composite nodes with strategy delegation"
```
