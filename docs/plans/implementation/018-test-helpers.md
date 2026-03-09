# Task 18: Integration Test Helpers

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `AbortTrackingNode` and `countingAction` helpers to `src/__integration__/helpers.ts` for use by new integration tests.

**Architecture:** Extends existing helpers file with two new exports. `AbortTrackingNode` is a `BaseNode` subclass; `countingAction` is a factory function similar to `sequentialAction`.

**Tech Stack:** TypeScript, vitest

---

### Step 1: Write tests for new helpers

Create `src/__integration__/helpers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { NodeStatus } from '../types.js';
import { AbortTrackingNode, countingAction, createContext } from './helpers.js';

describe('AbortTrackingNode', () => {
  it('returns configured status and tracks abort', async () => {
    const node = new AbortTrackingNode('test');
    const ctx = createContext();

    expect(node.aborted).toBe(false);
    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);

    node.abort();
    expect(node.aborted).toBe(true);
  });

  it('returns custom status', async () => {
    const node = new AbortTrackingNode('test', NodeStatus.SUCCESS);
    const ctx = createContext();
    const status = await node.tick(ctx);
    expect(status).toBe(NodeStatus.SUCCESS);
  });
});

describe('countingAction', () => {
  it('tracks tick count and follows status sequence', () => {
    const { config, getTicks } = countingAction('test', [
      NodeStatus.RUNNING,
      NodeStatus.SUCCESS,
    ]);

    expect(getTicks()).toBe(0);
    config.action({ blackboard: {} } as any);
    expect(getTicks()).toBe(1);
    config.action({ blackboard: {} } as any);
    expect(getTicks()).toBe(2);
  });

  it('repeats last status when sequence exhausted', () => {
    const { config, getTicks } = countingAction('test', [NodeStatus.FAILURE]);
    expect(config.action({ blackboard: {} } as any)).toBe(NodeStatus.FAILURE);
    expect(config.action({ blackboard: {} } as any)).toBe(NodeStatus.FAILURE);
    expect(getTicks()).toBe(2);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `npx vitest run src/__integration__/helpers.test.ts`
Expected: FAIL — `AbortTrackingNode` and `countingAction` are not exported from helpers.

### Step 3: Add AbortTrackingNode and countingAction to helpers.ts

Modify `src/__integration__/helpers.ts` — add these imports and exports at the end:

```typescript
import { BaseNode } from '../nodes/base.js';

export class AbortTrackingNode extends BaseNode {
  aborted = false;
  private status: NodeStatus;

  constructor(name: string, status: NodeStatus = NodeStatus.RUNNING) {
    super(name);
    this.status = status;
  }

  protected async execute(): Promise<NodeStatus> {
    return this.status;
  }

  abort(): void {
    this.aborted = true;
  }
}

export function countingAction(name: string, statuses: NodeStatus[]) {
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

### Step 4: Run tests to verify they pass

Run: `npx vitest run src/__integration__/helpers.test.ts`
Expected: PASS — all 4 tests pass.

### Step 5: Run all existing tests to verify no regressions

Run: `npm run test`
Expected: All unit tests pass.

### Step 6: Commit

```bash
git add src/__integration__/helpers.ts src/__integration__/helpers.test.ts
git commit -m "feat: add AbortTrackingNode and countingAction integration test helpers"
```
