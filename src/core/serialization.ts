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
