# Serialization API Reference

## serializeTree

```typescript
import { serializeTree } from 'cartographer';

function serializeTree(root: BTreeNode, rootHash: string): SerializedTreeState;
```

Walks the tree depth-first, calls `serialize()` on each node, and collects non-empty states into a flat `{ [contentHash]: NodeState }` map. Returns a `SerializedTreeState` with the root hash and node states.

---

## restoreTree

```typescript
import { restoreTree } from 'cartographer';

function restoreTree(
  root: BTreeNode,
  currentRootHash: string,
  stored: SerializedTreeState,
  policy?: 'fail' | 'reset',
): void;
```

Restores tree execution state from a serialized snapshot.

- If `stored.rootHash` matches `currentRootHash`, rebuilds the hash index and calls `restore()` on each node with its stored state. If the stored data references a node hash that doesn't exist in the current tree, throws an error regardless of policy (indicates corrupted state data).
- If root hashes differ and `policy` is `'fail'` (default), throws an error.
- If root hashes differ and `policy` is `'reset'`, silently skips restoration.

---

## buildHashIndex

```typescript
import { buildHashIndex } from 'cartographer';

function buildHashIndex(root: BTreeNode): Map<string, BTreeNode>;
```

Walks the tree depth-first and builds a `contentHash → node` map. Handles duplicate hashes by appending index suffixes (e.g., `abc123:0`, `abc123:1`).

---

## computeContentHash

```typescript
import { computeContentHash } from 'cartographer';

function computeContentHash(...parts: (string | string[])[]): string;
```

Computes a deterministic SHA-256 hash from the given parts, truncated to 16 hex characters. Used internally by all nodes for `contentHash()` computation.

---

## SerializedTreeState

```typescript
interface SerializedTreeState {
  rootHash: string;
  nodes: Record<string, NodeState>;
}
```

## NodeState

```typescript
interface NodeState {
  lastStatus?: NodeStatus;        // Leaf nodes: last terminal status
  committedOrder?: string[];      // Composites: child execution order as content hashes
  completedMap?: Record<string, NodeStatus>;  // Composites: completed children
  count?: number;                 // Decorators: retry/repeat counter
}
```

---

## BTreeNode Serialization Methods

Added to the `BTreeNode` interface:

#### `contentHash(): string`

Returns the node's deterministic content hash. Computed once and cached.

#### `serialize(): NodeState`

Returns this node's execution state for persistence. Default (BaseNode): empty object.

#### `restore(state: NodeState, hashToNode: Map<string, BTreeNode>): void`

Restores execution state from serialized data. Default (BaseNode): no-op.

---

## BehaviorTree Properties

#### `rootHash: string` (getter)

Content hash of the root node. Fingerprints the entire tree topology.

#### `hasInflightWork(): boolean`

Returns `true` if any node in the tree has unsettled async work.

#### `settled(): Promise<void>`

Resolves when all in-flight work in the tree has settled.
