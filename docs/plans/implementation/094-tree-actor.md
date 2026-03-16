# Task 94: TreeActor

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the transient TreeActor — the per-message processor that hydrates a tree from stored state, processes a message via `runToCompletion()`, and serializes back.

**Depends on:** Tasks 080–088 (inflight + serialization), 092 (message types), 093 (StateStore)

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 1 (Processing Loop, Async Processing Model)

---

### Context

The TreeActor is transient — created per request, processes one message, discarded. It encapsulates:
1. Load state from StateStore
2. Create tree from factory, restore execution state
3. Apply message (blackboard write if applicable)
4. `runToCompletion()` — tick until terminal or suspended
5. Serialize tree state
6. Save to StateStore
7. Emit `message:processed` or `message:failed`

The TreeActor does NOT handle HTTP, locking, or SSE — that's ActorServer's job.

### Step 1: Implement TreeActor

Create `src/actor/tree-actor.ts`:

```ts
import { BehaviorTree } from '../core/behavior-tree.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import { ObservableBlackboard } from '../core/observable-blackboard.js';
import { EventEmitter } from '../core/event-emitter.js';
import { serializeTree, restoreTree } from '../core/serialization.js';
import type { TreeEvents, NodeStatus } from '../types.js';
import type { StateStore, TreeSessionState } from '../state/state-store.js';
import type { ActorMessage } from './types.js';

export interface TreeActorOptions {
  createTree: () => BehaviorTree;
  stateStore: StateStore;
  stateKey: string;
  topologyPolicy?: 'fail' | 'reset';
}

export interface ProcessResult {
  treeStatus: NodeStatus | 'error';
  error?: string;
}

export class TreeActor {
  private createTree: () => BehaviorTree;
  private stateStore: StateStore;
  private stateKey: string;
  private topologyPolicy: 'fail' | 'reset';

  constructor(options: TreeActorOptions) {
    this.createTree = options.createTree;
    this.stateStore = options.stateStore;
    this.stateKey = options.stateKey;
    this.topologyPolicy = options.topologyPolicy ?? 'fail';
  }

  /**
   * Process a single message. Loads state, hydrates tree, processes, serializes, saves.
   * Returns the final tree status. Throws on unrecoverable errors.
   */
  async process(msg: ActorMessage): Promise<ProcessResult> {
    // 1. Create tree from factory
    const tree = this.createTree();

    // 2. Load and restore state
    const stored = await this.stateStore.getState(this.stateKey);
    if (stored) {
      // Restore blackboard
      const bb = tree.blackboard;
      for (const [key, value] of Object.entries(stored.blackboard)) {
        bb.set(key, value);
      }
      // Restore tree execution state
      restoreTree(tree.root, tree.rootHash, stored.treeState, this.topologyPolicy);
    }

    // 3. Apply message
    if (msg.type === 'action') {
      tree.blackboard.set(`actions:${msg.name}`, msg.payload);
      tree.events.emit('actor:message:received', msg as any);
    } else if (msg.type === 'write') {
      tree.blackboard.set(msg.key, msg.value);
    } else if (msg.type === 'signal') {
      return this.handleSignal(tree, msg.signal);
    }
    // type === 'tick': just run the tick loop

    // 4. Run to completion
    const treeStatus = await this.runToCompletion(tree);

    // 5. Serialize and save
    const blackboardSnapshot = this.serializeBlackboard(tree.blackboard);
    const treeState = serializeTree(tree.root, tree.rootHash);
    await this.stateStore.saveState(this.stateKey, {
      blackboard: blackboardSnapshot,
      treeState,
      createdAt: stored?.createdAt ?? Date.now(),
      lastMessageAt: Date.now(),
    });

    return { treeStatus };
  }

  private async runToCompletion(tree: BehaviorTree): Promise<NodeStatus> {
    let status: NodeStatus;
    do {
      status = await tree.tick();
      if (status !== NodeStatus.RUNNING) break;     // terminal
      if (!tree.hasInflightWork()) break;            // suspended
      await tree.settled();                          // wait for in-flight work
    } while (true);
    return status;
  }

  private handleSignal(tree: BehaviorTree, signal: string): ProcessResult {
    if (signal === 'reset') tree.reset();
    if (signal === 'abort') tree.abort();
    return { treeStatus: 'error', error: `Signal handled: ${signal}` };
  }

  private serializeBlackboard(blackboard: any): Record<string, unknown> {
    // Extract all key-value pairs from the blackboard
    // Check if blackboard has entries(), toJSON(), or similar
    const result: Record<string, unknown> = {};
    if (typeof blackboard.entries === 'function') {
      for (const [key, value] of blackboard.entries()) {
        result[key] = value;
      }
    }
    return result;
  }
}
```

Note: Check the actual BehaviorTree API for:
- How to access `tree.blackboard` (it may be a getter)
- How to access `tree.root` (for serialization)
- The `NodeStatus` import path
- How `blackboard.set()` and iteration work
- Whether `tree.events` is accessible

Adjust the implementation based on what you find in `src/core/behavior-tree.ts` and `src/core/blackboard.ts`.

### Step 2: Write tests

Create `src/actor/tree-actor.test.ts`:

```ts
describe('TreeActor', () => {
  it('processes a tick message and saves state', async () => {
    const store = new InMemoryStateStore();
    const actor = new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({ name: 'fast', action: async () => NodeStatus.SUCCESS }),
      }),
      stateStore: store,
      stateKey: 'default',
    });

    const result = await actor.process({ type: 'tick' });
    expect(result.treeStatus).toBe(NodeStatus.SUCCESS);

    const saved = await store.getState('default');
    expect(saved).not.toBeNull();
    expect(saved!.treeState.rootHash).toBeDefined();
  });

  it('processes an action message — writes to blackboard then ticks', async () => {
    let receivedValue: unknown;
    const store = new InMemoryStateStore();
    const actor = new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({
          name: 'check',
          action: async (ctx) => {
            receivedValue = ctx.blackboard.get('actions:approve');
            return NodeStatus.SUCCESS;
          },
        }),
      }),
      stateStore: store,
      stateKey: 'default',
    });

    await actor.process({ type: 'action', name: 'approve', payload: { docId: '123' } });
    expect(receivedValue).toEqual({ docId: '123' });
  });

  it('restores state across invocations', async () => {
    const store = new InMemoryStateStore();
    let tickCount = 0;

    const makeActor = () => new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({
          name: 'counter',
          action: async (ctx) => {
            tickCount++;
            return NodeStatus.SUCCESS;
          },
        }),
      }),
      stateStore: store,
      stateKey: 'default',
    });

    // First invocation
    await makeActor().process({ type: 'tick' });
    expect(tickCount).toBe(1);

    // Second invocation (new actor, loads state)
    await makeActor().process({ type: 'tick' });
    expect(tickCount).toBe(2);
  });

  it('runToCompletion ticks until suspended (not terminal)', async () => {
    // Use untilSuccess to create a suspension point
    const store = new InMemoryStateStore();
    const actor = new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: untilSuccess(
          actionReceived('approve'),
        ),
      }),
      stateStore: store,
      stateKey: 'default',
    });

    // No action present → untilSuccess returns RUNNING (suspension)
    const result = await actor.process({ type: 'tick' });
    expect(result.treeStatus).toBe(NodeStatus.RUNNING);
  });

  it('throws on topology mismatch with fail policy', async () => {
    const store = new InMemoryStateStore();

    // Save state with one tree
    const actor1 = new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({ name: 'v1', action: async () => NodeStatus.SUCCESS }),
      }),
      stateStore: store,
      stateKey: 'default',
    });
    await actor1.process({ type: 'tick' });

    // Try to restore with a different tree
    const actor2 = new TreeActor({
      createTree: () => new BehaviorTree({
        name: 'test',
        root: new ActionNode({ name: 'v2', action: async () => NodeStatus.SUCCESS }),
      }),
      stateStore: store,
      stateKey: 'default',
      topologyPolicy: 'fail',
    });

    await expect(actor2.process({ type: 'tick' })).rejects.toThrow(/topology changed/);
  });
});
```

### Step 3: Run tests

Run: `npx vitest run src/actor/tree-actor.test.ts`
Expected: All pass.

### Step 4: Typecheck + full suite

Run: `npm run typecheck && npm run test`

### Step 5: Commit

```bash
git add src/actor/tree-actor.ts src/actor/tree-actor.test.ts
git commit -m "feat(actor): add TreeActor transient per-message processor with runToCompletion"
```
