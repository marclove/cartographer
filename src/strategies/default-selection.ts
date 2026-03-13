import type { SelectionStrategy, BTreeNode, TreeContext } from '../types.js';

export class DefaultSelectionStrategy implements SelectionStrategy {
  order(children: BTreeNode[], _context: TreeContext): BTreeNode[] {
    return children;
  }
}
