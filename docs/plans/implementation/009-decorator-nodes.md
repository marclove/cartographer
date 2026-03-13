# Task 9: Decorator Nodes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement all seven decorator nodes: Inverter, Repeat, Retry, AlwaysSucceed, AlwaysFail, Timeout, Guard.

**Architecture:** Each decorator extends `BaseNode`, wraps a single child, and modifies the child's tick result or execution pattern.

**Tech Stack:** TypeScript

---

### Step 1: Write failing tests for all decorators

Create `src/decorators/decorators.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { InverterNode } from "./inverter.js";
import { RepeatNode } from "./repeat.js";
import { RetryNode } from "./retry.js";
import { AlwaysSucceedNode } from "./always-succeed.js";
import { AlwaysFailNode } from "./always-fail.js";
import { TimeoutNode } from "./timeout.js";
import { GuardNode } from "./guard.js";
import { NodeStatus } from "../types.js";
import type { BTreeNode, TreeContext } from "../types.js";
import { EventEmitter } from "../core/event-emitter.js";
import { InMemoryBlackboard } from "../core/blackboard.js";
import type { TreeEvents } from "../types.js";

function createContext(): TreeContext {
  return {
    blackboard: new InMemoryBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

function mockChild(status: NodeStatus): BTreeNode {
  return {
    id: "child",
    name: "child",
    tick: vi.fn(async () => status),
    reset: vi.fn(),
    abort: vi.fn(),
  };
}

function dynamicChild(statuses: NodeStatus[]): BTreeNode {
  let call = 0;
  return {
    id: "child",
    name: "child",
    tick: vi.fn(async () => statuses[call++] ?? NodeStatus.FAILURE),
    reset: vi.fn(),
    abort: vi.fn(),
  };
}

// --- Inverter ---

describe("InverterNode", () => {
  it("flips SUCCESS to FAILURE", async () => {
    const node = new InverterNode({ name: "inv", child: mockChild(NodeStatus.SUCCESS) });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it("flips FAILURE to SUCCESS", async () => {
    const node = new InverterNode({ name: "inv", child: mockChild(NodeStatus.FAILURE) });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it("passes RUNNING through unchanged", async () => {
    const node = new InverterNode({ name: "inv", child: mockChild(NodeStatus.RUNNING) });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });

  it("delegates reset to child", () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new InverterNode({ name: "inv", child });
    node.reset();
    expect(child.reset).toHaveBeenCalled();
  });
});

// --- Repeat ---

describe("RepeatNode", () => {
  it("repeats child N times", async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new RepeatNode({ name: "rep", child, count: 3 });

    const status = await node.tick(createContext());

    expect(status).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(3);
  });

  it("stops early when child returns target status", async () => {
    const child = dynamicChild([NodeStatus.SUCCESS, NodeStatus.FAILURE, NodeStatus.SUCCESS]);
    const node = new RepeatNode({ name: "rep", child, count: 10, untilStatus: NodeStatus.FAILURE });

    const status = await node.tick(createContext());

    expect(status).toBe(NodeStatus.FAILURE);
    expect(child.tick).toHaveBeenCalledTimes(2);
  });

  it("stops early on RUNNING", async () => {
    const child = dynamicChild([NodeStatus.SUCCESS, NodeStatus.RUNNING]);
    const node = new RepeatNode({ name: "rep", child, count: 5 });

    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
    expect(child.tick).toHaveBeenCalledTimes(2);
  });
});

// --- Retry ---

describe("RetryNode", () => {
  it("returns SUCCESS on first try if child succeeds", async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new RetryNode({ name: "retry", child, maxAttempts: 3 });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(1);
  });

  it("retries on FAILURE up to maxAttempts", async () => {
    const child = mockChild(NodeStatus.FAILURE);
    const node = new RetryNode({ name: "retry", child, maxAttempts: 3 });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
    expect(child.tick).toHaveBeenCalledTimes(3);
  });

  it("succeeds if a retry succeeds", async () => {
    const child = dynamicChild([NodeStatus.FAILURE, NodeStatus.FAILURE, NodeStatus.SUCCESS]);
    const node = new RetryNode({ name: "retry", child, maxAttempts: 5 });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalledTimes(3);
  });

  it("returns RUNNING immediately without retry", async () => {
    const child = mockChild(NodeStatus.RUNNING);
    const node = new RetryNode({ name: "retry", child, maxAttempts: 3 });

    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
    expect(child.tick).toHaveBeenCalledTimes(1);
  });

  it("delays between retries when delayMs is set", async () => {
    const child = dynamicChild([NodeStatus.FAILURE, NodeStatus.SUCCESS]);
    const node = new RetryNode({ name: "retry", child, maxAttempts: 3, delayMs: 50 });

    const start = performance.now();
    await node.tick(createContext());
    const elapsed = performance.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(40); // allow some timing slack
  });
});

// --- AlwaysSucceed ---

describe("AlwaysSucceedNode", () => {
  it("returns SUCCESS when child succeeds", async () => {
    const node = new AlwaysSucceedNode({ name: "as", child: mockChild(NodeStatus.SUCCESS) });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it("returns SUCCESS when child fails", async () => {
    const node = new AlwaysSucceedNode({ name: "as", child: mockChild(NodeStatus.FAILURE) });
    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it("returns RUNNING when child returns RUNNING", async () => {
    const node = new AlwaysSucceedNode({ name: "as", child: mockChild(NodeStatus.RUNNING) });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });
});

// --- AlwaysFail ---

describe("AlwaysFailNode", () => {
  it("returns FAILURE when child succeeds", async () => {
    const node = new AlwaysFailNode({ name: "af", child: mockChild(NodeStatus.SUCCESS) });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it("returns FAILURE when child fails", async () => {
    const node = new AlwaysFailNode({ name: "af", child: mockChild(NodeStatus.FAILURE) });
    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it("returns RUNNING when child returns RUNNING", async () => {
    const node = new AlwaysFailNode({ name: "af", child: mockChild(NodeStatus.RUNNING) });
    expect(await node.tick(createContext())).toBe(NodeStatus.RUNNING);
  });
});

// --- Timeout ---

describe("TimeoutNode", () => {
  it("returns child status when child completes within timeout", async () => {
    const node = new TimeoutNode({
      name: "to",
      child: mockChild(NodeStatus.SUCCESS),
      timeoutMs: 1000,
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it("returns FAILURE when child exceeds timeout", async () => {
    const slowChild: BTreeNode = {
      id: "slow",
      name: "slow",
      tick: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return NodeStatus.SUCCESS;
      },
      reset: () => {},
      abort: vi.fn(),
    };

    const node = new TimeoutNode({ name: "to", child: slowChild, timeoutMs: 50 });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });
});

// --- Guard ---

describe("GuardNode", () => {
  it("ticks child when condition is true", async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new GuardNode({ name: "guard", child, condition: () => true });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
    expect(child.tick).toHaveBeenCalled();
  });

  it("returns FAILURE without ticking child when condition is false", async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new GuardNode({ name: "guard", child, condition: () => false });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
    expect(child.tick).not.toHaveBeenCalled();
  });

  it("supports async conditions", async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new GuardNode({ name: "guard", child, condition: async () => true });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it("returns FAILURE when condition throws", async () => {
    const child = mockChild(NodeStatus.SUCCESS);
    const node = new GuardNode({
      name: "guard",
      child,
      condition: () => {
        throw new Error("boom");
      },
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
    expect(child.tick).not.toHaveBeenCalled();
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/decorators/decorators.test.ts`
Expected: FAIL — cannot import decorator classes

### Step 3: Implement InverterNode

Create `src/decorators/inverter.ts`:

```typescript
import { BaseNode } from "../nodes/base.js";
import { NodeStatus } from "../types.js";
import type { DecoratorConfig, TreeContext } from "../types.js";

export class InverterNode extends BaseNode {
  private child: DecoratorConfig["child"];

  constructor(config: DecoratorConfig) {
    super(config.name);
    this.child = config.child;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const status = await this.child.tick(context);
    if (status === NodeStatus.SUCCESS) return NodeStatus.FAILURE;
    if (status === NodeStatus.FAILURE) return NodeStatus.SUCCESS;
    return NodeStatus.RUNNING;
  }

  reset(): void {
    this.child.reset();
  }
  abort(): void {
    this.child.abort();
  }
}
```

### Step 4: Implement RepeatNode

Create `src/decorators/repeat.ts`:

```typescript
import { BaseNode } from "../nodes/base.js";
import { NodeStatus } from "../types.js";
import type { RepeatConfig, TreeContext } from "../types.js";

export class RepeatNode extends BaseNode {
  private child: RepeatConfig["child"];
  private count?: number;
  private untilStatus?: NodeStatus;

  constructor(config: RepeatConfig) {
    super(config.name);
    this.child = config.child;
    this.count = config.count;
    this.untilStatus = config.untilStatus;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const limit = this.count ?? Infinity;
    let lastStatus = NodeStatus.SUCCESS;

    for (let i = 0; i < limit; i++) {
      lastStatus = await this.child.tick(context);

      if (lastStatus === NodeStatus.RUNNING) {
        return NodeStatus.RUNNING;
      }

      if (this.untilStatus !== undefined && lastStatus === this.untilStatus) {
        return lastStatus;
      }
    }

    return lastStatus;
  }

  reset(): void {
    this.child.reset();
  }
  abort(): void {
    this.child.abort();
  }
}
```

### Step 5: Implement RetryNode

Create `src/decorators/retry.ts`:

```typescript
import { BaseNode } from "../nodes/base.js";
import { NodeStatus } from "../types.js";
import type { RetryConfig, TreeContext } from "../types.js";

export class RetryNode extends BaseNode {
  private child: RetryConfig["child"];
  private maxAttempts: number;
  private delayMs?: number;

  constructor(config: RetryConfig) {
    super(config.name);
    this.child = config.child;
    this.maxAttempts = config.maxAttempts;
    this.delayMs = config.delayMs;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const status = await this.child.tick(context);

      if (status !== NodeStatus.FAILURE) {
        return status;
      }

      if (attempt < this.maxAttempts - 1 && this.delayMs) {
        await new Promise((r) => setTimeout(r, this.delayMs));
      }
    }

    return NodeStatus.FAILURE;
  }

  reset(): void {
    this.child.reset();
  }
  abort(): void {
    this.child.abort();
  }
}
```

### Step 6: Implement AlwaysSucceedNode

Create `src/decorators/always-succeed.ts`:

```typescript
import { BaseNode } from "../nodes/base.js";
import { NodeStatus } from "../types.js";
import type { DecoratorConfig, TreeContext } from "../types.js";

export class AlwaysSucceedNode extends BaseNode {
  private child: DecoratorConfig["child"];

  constructor(config: DecoratorConfig) {
    super(config.name);
    this.child = config.child;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const status = await this.child.tick(context);
    if (status === NodeStatus.RUNNING) return NodeStatus.RUNNING;
    return NodeStatus.SUCCESS;
  }

  reset(): void {
    this.child.reset();
  }
  abort(): void {
    this.child.abort();
  }
}
```

### Step 7: Implement AlwaysFailNode

Create `src/decorators/always-fail.ts`:

```typescript
import { BaseNode } from "../nodes/base.js";
import { NodeStatus } from "../types.js";
import type { DecoratorConfig, TreeContext } from "../types.js";

export class AlwaysFailNode extends BaseNode {
  private child: DecoratorConfig["child"];

  constructor(config: DecoratorConfig) {
    super(config.name);
    this.child = config.child;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const status = await this.child.tick(context);
    if (status === NodeStatus.RUNNING) return NodeStatus.RUNNING;
    return NodeStatus.FAILURE;
  }

  reset(): void {
    this.child.reset();
  }
  abort(): void {
    this.child.abort();
  }
}
```

### Step 8: Implement TimeoutNode

Create `src/decorators/timeout.ts`:

```typescript
import { BaseNode } from "../nodes/base.js";
import { NodeStatus } from "../types.js";
import type { TimeoutConfig, TreeContext } from "../types.js";

export class TimeoutNode extends BaseNode {
  private child: TimeoutConfig["child"];
  private timeoutMs: number;

  constructor(config: TimeoutConfig) {
    super(config.name);
    this.child = config.child;
    this.timeoutMs = config.timeoutMs;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const timeoutPromise = new Promise<NodeStatus>((resolve) => {
      setTimeout(() => resolve(NodeStatus.FAILURE), this.timeoutMs);
    });

    const result = await Promise.race([this.child.tick(context), timeoutPromise]);

    if (result === NodeStatus.FAILURE && timeoutPromise) {
      this.child.abort();
    }

    return result;
  }

  reset(): void {
    this.child.reset();
  }
  abort(): void {
    this.child.abort();
  }
}
```

### Step 9: Implement GuardNode

Create `src/decorators/guard.ts`:

```typescript
import { BaseNode } from "../nodes/base.js";
import { NodeStatus } from "../types.js";
import type { GuardConfig, TreeContext } from "../types.js";

export class GuardNode extends BaseNode {
  private child: GuardConfig["child"];
  private condition: GuardConfig["condition"];

  constructor(config: GuardConfig) {
    super(config.name);
    this.child = config.child;
    this.condition = config.condition;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    try {
      const allowed = await this.condition(context);
      if (!allowed) {
        return NodeStatus.FAILURE;
      }
    } catch {
      return NodeStatus.FAILURE;
    }

    return this.child.tick(context);
  }

  reset(): void {
    this.child.reset();
  }
  abort(): void {
    this.child.abort();
  }
}
```

### Step 10: Run tests to verify they all pass

Run: `npx vitest run src/decorators/decorators.test.ts`
Expected: PASS (all 21 tests)

### Step 11: Commit

```bash
git add src/decorators/inverter.ts src/decorators/repeat.ts src/decorators/retry.ts src/decorators/always-succeed.ts src/decorators/always-fail.ts src/decorators/timeout.ts src/decorators/guard.ts src/decorators/decorators.test.ts
git commit -m "feat: implement all decorator nodes (inverter, repeat, retry, always-succeed, always-fail, timeout, guard)"
```
