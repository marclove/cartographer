import type { NodeStatus, BTreeNode } from '../types.js';

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

/**
 * Walk the tree depth-first, compute content hashes, and build a hash→node index.
 * Handles duplicate hashes by appending occurrence index (e.g., 'abc123:0', 'abc123:1').
 */
export function buildHashIndex(root: BTreeNode): Map<string, BTreeNode> {
  const counts = new Map<string, number>();
  const index = new Map<string, BTreeNode>();

  function walk(node: BTreeNode): void {
    const rawHash = node.contentHash();
    const count = counts.get(rawHash) ?? 0;
    counts.set(rawHash, count + 1);

    const key = count > 0 ? `${rawHash}:${count}` : rawHash;
    if (count === 1) {
      const firstNode = index.get(rawHash)!;
      index.delete(rawHash);
      index.set(`${rawHash}:0`, firstNode);
    }
    index.set(key, node);

    for (const child of node.children) {
      walk(child);
    }
  }

  walk(root);
  return index;
}

/** Serialize the entire tree's execution state. */
export function serializeTree(root: BTreeNode, rootHash: string): SerializedTreeState {
  const index = buildHashIndex(root);
  const nodes: Record<string, NodeState> = {};

  for (const [hash, node] of index) {
    const state = node.serialize();
    if (Object.keys(state).length > 0) {
      nodes[hash] = state;
    }
  }

  return { rootHash, nodes };
}

/** Restore tree execution state. Throws if rootHash doesn't match (fail policy). */
export function restoreTree(
  root: BTreeNode,
  currentRootHash: string,
  stored: SerializedTreeState,
  policy: 'fail' | 'reset' = 'fail',
): void {
  if (stored.rootHash !== currentRootHash) {
    if (policy === 'fail') {
      throw new Error(
        `Tree topology changed: stored rootHash ${stored.rootHash} does not match factory rootHash ${currentRootHash}`
      );
    }
    return;
  }

  const index = buildHashIndex(root);

  for (const [hash, state] of Object.entries(stored.nodes)) {
    const node = index.get(hash);
    if (!node) {
      throw new Error(`Stored state references unknown node hash: ${hash}`);
    }
    node.restore(state, index);
  }
}
