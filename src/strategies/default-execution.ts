import type { ExecutionStrategy, BTreeNode, TreeContext } from '../types.js';

export class DefaultExecutionStrategy implements ExecutionStrategy {
  async order(children: BTreeNode[], _context: TreeContext): Promise<BTreeNode[]> {
    return children;
  }
}
