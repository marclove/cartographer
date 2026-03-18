import type { ExecutionStrategy, BTreeNode, TreeContext } from '../types.js';

export class DefaultExecutionStrategy implements ExecutionStrategy {
  order(children: BTreeNode[], _context: TreeContext): BTreeNode[] {
    return children;
  }
}
