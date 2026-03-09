import type { SelectionStrategy, BTreeNode, TreeContext } from '../types.js';

export class DefaultSelectionStrategy implements SelectionStrategy {
  async order(children: BTreeNode[], _context: TreeContext): Promise<BTreeNode[]> {
    return children;
  }
}
