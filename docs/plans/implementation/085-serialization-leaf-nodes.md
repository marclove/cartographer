# Task 85: Serialization — Leaf Nodes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `serialize()` and `restore()` methods to BaseNode and leaf node types. Leaf nodes serialize their last terminal status only.

**Depends on:** Task 83

**Spec Reference:** `docs/plans/2026-03-15-agent-enabled-application-framework.md` — Section 2 (Serializable Execution State, Restore Process)

---

### Context

Serialization captures the tree's execution state as a flat `{ [contentHash]: NodeState }` map. Leaf nodes (ActionNode, AgentNode, ConditionNode) only need to serialize their last terminal status. `_inflightState` is never serialized — the `runToCompletion()` loop guarantees the tree is at rest.

### Step 1: Define NodeState type

Create `src/core/serialization.ts`:

```ts
import type { NodeStatus } from '../types.js';

/** Serialized state for a single node, keyed by content hash in SerializedTreeState. */
export interface NodeState {
  /** Last terminal status (SUCCESS or FAILURE). Null if never ticked. */
  lastStatus?: NodeStatus;
  /** Composite-specific: committed child order as content hashes. */
  committedOrder?: string[];
  /** Composite-specific: completed children map (content hash → terminal status). */
  completedMap?: Record<string, NodeStatus>;
  /** Decorator-specific: current count (retry/repeat). */
  count?: number;
}

export interface SerializedTreeState {
  rootHash: string;
  nodes: Record<string, NodeState>;
}
```

### Step 2: Add serialize/restore to BTreeNode interface

Edit `src/types.ts`:

```ts
/** Serialize this node's execution state. */
serialize(): NodeState;

/** Restore this node's execution state from serialized data. */
restore(state: NodeState, hashToNode: Map<string, BTreeNode>): void;
```

Add the `NodeState` import from `src/core/serialization.js`.

### Step 3: Default implementation on BaseNode

Edit `src/nodes/base.ts`:

```ts
serialize(): NodeState {
  return {};
}

restore(_state: NodeState, _hashToNode: Map<string, BTreeNode>): void {
  // Default: no state to restore
}
```

### Step 4: Implement on ActionNode

ActionNode tracks its last terminal status. Check how the current `execute()` method works — after polling `_inflightState.result`, that's the last status.

Add a field to track it:

```ts
private _lastTerminalStatus: NodeStatus | null = null;
```

Update `execute()` to record the status when it returns SUCCESS or FAILURE (not RUNNING).

```ts
serialize(): NodeState {
  return this._lastTerminalStatus !== null
    ? { lastStatus: this._lastTerminalStatus }
    : {};
}

restore(state: NodeState): void {
  if (state.lastStatus !== undefined) {
    this._lastTerminalStatus = state.lastStatus;
  }
}
```

### Step 5: Implement on AgentNode

Same pattern as ActionNode — track and serialize last terminal status. Check if AgentNode already has a `cachedStatus` field (the spec mentions `cache: true` support) and reuse it if appropriate.

### Step 6: Implement on ConditionNode

ConditionNode is reactive and typically doesn't need state restoration (it's re-evaluated each tick). Serialize as empty state:

```ts
serialize(): NodeState {
  return {};
}
```

### Step 7: Write tests

Add to `src/core/serialization.test.ts`:

```ts
describe('leaf node serialization', () => {
  it('ActionNode serializes last terminal status', async () => {
    const node = new ActionNode({ name: 'test', action: async () => NodeStatus.SUCCESS });
    const ctx = createTestContext();
    await node.tick(ctx); // RUNNING
    await new Promise(r => setTimeout(r, 0));
    await node.tick(ctx); // SUCCESS

    const state = node.serialize();
    expect(state.lastStatus).toBe(NodeStatus.SUCCESS);
  });

  it('ActionNode restores last terminal status', () => {
    const node = new ActionNode({ name: 'test', action: async () => NodeStatus.SUCCESS });
    node.restore({ lastStatus: NodeStatus.SUCCESS }, new Map());
    const state = node.serialize();
    expect(state.lastStatus).toBe(NodeStatus.SUCCESS);
  });

  it('unticked node serializes empty state', () => {
    const node = new ActionNode({ name: 'test', action: async () => NodeStatus.SUCCESS });
    expect(node.serialize()).toEqual({});
  });
});
```

### Step 8: Run tests

Run: `npx vitest run src/core/serialization.test.ts src/nodes/`
Expected: All pass.

### Step 9: Typecheck

Run: `npm run typecheck`

### Step 10: Commit

```bash
git add src/types.ts src/core/serialization.ts src/core/serialization.test.ts src/nodes/base.ts src/nodes/action.ts src/nodes/agent.ts src/nodes/condition.ts
git commit -m "feat(core): add serialize/restore to BTreeNode interface and leaf nodes"
```
