# Task 5: Base Node Class

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the abstract base node class that all concrete nodes extend. Handles ID generation, event emission on enter/exit, and abort signal wiring.

**Architecture:** Abstract class `BaseNode` implements `BTreeNode`. Subclasses override `execute()` (the actual logic). `tick()` wraps `execute()` with event emission and timing.

**Tech Stack:** TypeScript, uuid

---

### Step 1: Write failing tests

Create `src/nodes/base.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { BaseNode } from './base.js';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { MapBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';

class TestNode extends BaseNode {
  public executeFn: (context: TreeContext) => Promise<NodeStatus> = async () => NodeStatus.SUCCESS;

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    return this.executeFn(context);
  }
}

function createContext(): TreeContext {
  return {
    blackboard: new MapBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

describe('BaseNode', () => {
  it('generates a unique id', () => {
    const node1 = new TestNode('node-a');
    const node2 = new TestNode('node-b');
    expect(node1.id).toBeTruthy();
    expect(node2.id).toBeTruthy();
    expect(node1.id).not.toBe(node2.id);
  });

  it('stores the name', () => {
    const node = new TestNode('my-node');
    expect(node.name).toBe('my-node');
  });

  it('tick() returns the status from execute()', async () => {
    const node = new TestNode('node');
    node.executeFn = async () => NodeStatus.FAILURE;

    const status = await node.tick(createContext());
    expect(status).toBe(NodeStatus.FAILURE);
  });

  it('emits node:enter and node:exit events on tick', async () => {
    const node = new TestNode('node');
    const context = createContext();
    const enterSpy = vi.fn();
    const exitSpy = vi.fn();

    context.events.on('node:enter', enterSpy);
    context.events.on('node:exit', exitSpy);

    await node.tick(context);

    expect(enterSpy).toHaveBeenCalledOnce();
    expect(enterSpy).toHaveBeenCalledWith(expect.objectContaining({ node }));
    expect(exitSpy).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ node, status: NodeStatus.SUCCESS })
    );
  });

  it('emits node:exit with durationMs', async () => {
    const node = new TestNode('node');
    const context = createContext();
    const exitSpy = vi.fn();
    context.events.on('node:exit', exitSpy);

    await node.tick(context);

    expect(exitSpy.mock.calls[0][0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits node:error when execute throws', async () => {
    const node = new TestNode('node');
    const error = new Error('boom');
    node.executeFn = async () => { throw error; };

    const context = createContext();
    const errorSpy = vi.fn();
    context.events.on('node:error', errorSpy);

    const status = await node.tick(context);

    expect(status).toBe(NodeStatus.FAILURE);
    expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ node, error }));
  });

  it('reset() is callable', () => {
    const node = new TestNode('node');
    expect(() => node.reset()).not.toThrow();
  });

  it('abort() is callable', () => {
    const node = new TestNode('node');
    expect(() => node.abort()).not.toThrow();
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/nodes/base.test.ts`
Expected: FAIL — cannot import `BaseNode`

### Step 3: Implement BaseNode

Create `src/nodes/base.ts`:

```typescript
import { v4 as uuidv4 } from 'uuid';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';

export abstract class BaseNode implements BTreeNode {
  readonly id: string;
  readonly name: string;

  constructor(name: string) {
    this.id = uuidv4();
    this.name = name;
  }

  async tick(context: TreeContext): Promise<NodeStatus> {
    context.events.emit('node:enter', { node: this, context });
    const start = performance.now();

    try {
      const status = await this.execute(context);
      const durationMs = performance.now() - start;
      context.events.emit('node:exit', { node: this, status, context, durationMs });
      return status;
    } catch (error) {
      const durationMs = performance.now() - start;
      context.events.emit('node:error', { node: this, error: error as Error, context });
      context.events.emit('node:exit', {
        node: this,
        status: NodeStatus.FAILURE,
        context,
        durationMs,
      });
      return NodeStatus.FAILURE;
    }
  }

  reset(): void {
    // Subclasses override if they have state to reset
  }

  abort(): void {
    // Subclasses override if they have in-progress work to cancel
  }

  protected abstract execute(context: TreeContext): Promise<NodeStatus>;
}
```

### Step 4: Run test to verify it passes

Run: `npx vitest run src/nodes/base.test.ts`
Expected: PASS (all 8 tests)

### Step 5: Commit

```bash
git add src/nodes/base.ts src/nodes/base.test.ts
git commit -m "feat: implement base node with event emission and error handling"
```
