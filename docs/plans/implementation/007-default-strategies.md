# Task 7: Default Strategies

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the three default (deterministic) strategies that composites use when no agent strategy is provided.

**Architecture:** Each strategy implements its interface from `types.ts`. They are pass-through: default selection/execution returns children in original order, default parallel returns a fixed policy.

**Tech Stack:** TypeScript

---

### Step 1: Write failing tests

Create `src/strategies/default-strategies.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { DefaultSelectionStrategy } from './default-selection.js';
import { DefaultExecutionStrategy } from './default-execution.js';
import { DefaultParallelStrategy } from './default-parallel.js';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { MapBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';

function createContext(): TreeContext {
  return {
    blackboard: new MapBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

function mockNode(name: string): BTreeNode {
  return {
    id: name,
    name,
    tick: async () => NodeStatus.SUCCESS,
    reset: () => {},
    abort: () => {},
  };
}

describe('DefaultSelectionStrategy', () => {
  it('returns children in original order', async () => {
    const strategy = new DefaultSelectionStrategy();
    const children = [mockNode('a'), mockNode('b'), mockNode('c')];

    const result = await strategy.order(children, createContext());

    expect(result.map((n) => n.name)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array for no children', async () => {
    const strategy = new DefaultSelectionStrategy();
    const result = await strategy.order([], createContext());
    expect(result).toEqual([]);
  });
});

describe('DefaultExecutionStrategy', () => {
  it('returns children in original order', async () => {
    const strategy = new DefaultExecutionStrategy();
    const children = [mockNode('x'), mockNode('y')];

    const result = await strategy.order(children, createContext());

    expect(result.map((n) => n.name)).toEqual(['x', 'y']);
  });
});

describe('DefaultParallelStrategy', () => {
  it('returns the configured policy', async () => {
    const strategy = new DefaultParallelStrategy({ successCount: 2 });
    const result = await strategy.policy([mockNode('a'), mockNode('b')], createContext());
    expect(result).toEqual({ successCount: 2 });
  });

  it('defaults to requiring all children to succeed', async () => {
    const children = [mockNode('a'), mockNode('b'), mockNode('c')];
    const strategy = new DefaultParallelStrategy();
    const result = await strategy.policy(children, createContext());
    expect(result).toEqual({ successCount: 3 });
  });

  it('supports successPercentage', async () => {
    const strategy = new DefaultParallelStrategy({ successPercentage: 50 });
    const result = await strategy.policy([], createContext());
    expect(result).toEqual({ successPercentage: 50 });
  });

  it('supports failureCount', async () => {
    const strategy = new DefaultParallelStrategy({ failureCount: 1 });
    const result = await strategy.policy([], createContext());
    expect(result).toEqual({ failureCount: 1 });
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/strategies/default-strategies.test.ts`
Expected: FAIL — cannot import strategies

### Step 3: Implement DefaultSelectionStrategy

Create `src/strategies/default-selection.ts`:

```typescript
import type { SelectionStrategy, BTreeNode, TreeContext } from '../types.js';

export class DefaultSelectionStrategy implements SelectionStrategy {
  async order(children: BTreeNode[], _context: TreeContext): Promise<BTreeNode[]> {
    return children;
  }
}
```

### Step 4: Implement DefaultExecutionStrategy

Create `src/strategies/default-execution.ts`:

```typescript
import type { ExecutionStrategy, BTreeNode, TreeContext } from '../types.js';

export class DefaultExecutionStrategy implements ExecutionStrategy {
  async order(children: BTreeNode[], _context: TreeContext): Promise<BTreeNode[]> {
    return children;
  }
}
```

### Step 5: Implement DefaultParallelStrategy

Create `src/strategies/default-parallel.ts`:

```typescript
import type { ParallelStrategy, ParallelPolicy, BTreeNode, TreeContext } from '../types.js';

export class DefaultParallelStrategy implements ParallelStrategy {
  private configuredPolicy?: ParallelPolicy;

  constructor(policy?: ParallelPolicy) {
    this.configuredPolicy = policy;
  }

  async policy(children: BTreeNode[], _context: TreeContext): Promise<ParallelPolicy> {
    if (this.configuredPolicy) {
      return this.configuredPolicy;
    }
    return { successCount: children.length };
  }
}
```

### Step 6: Run test to verify it passes

Run: `npx vitest run src/strategies/default-strategies.test.ts`
Expected: PASS (all 7 tests)

### Step 7: Commit

```bash
git add src/strategies/default-selection.ts src/strategies/default-execution.ts src/strategies/default-parallel.ts src/strategies/default-strategies.test.ts
git commit -m "feat: implement default deterministic strategies for composites"
```
