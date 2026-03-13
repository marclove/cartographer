import type { BTreeNode } from '../types.js';
import { ConditionNode } from '../nodes/condition.js';

/**
 * Determines whether a node is "reactive" — i.e., should be re-evaluated on
 * every tick rather than cached within a cycle.
 *
 * A node is reactive if:
 * - It is a `ConditionNode` (conditions are always reactive), or
 * - It is a single-child wrapper (decorator) whose child is reactive.
 *
 * Everything else (actions, agents, composites) is non-reactive.
 */
export function isReactiveNode(node: BTreeNode): boolean {
  if (node instanceof ConditionNode) return true;
  // Single-child nodes (decorators) inherit reactivity from their child.
  // We use children.length === 1 because there is no shared decorator base class.
  if (node.children.length === 1) return isReactiveNode(node.children[0]);
  return false;
}
