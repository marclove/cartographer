import type { ParallelStrategy, ParallelPolicy, BTreeNode, TreeContext } from '../types.js';

export class DefaultParallelStrategy implements ParallelStrategy {
  private configuredPolicy?: ParallelPolicy;

  constructor(policy?: ParallelPolicy) {
    this.configuredPolicy = policy;
  }

  policy(children: BTreeNode[], _context: TreeContext): ParallelPolicy {
    if (this.configuredPolicy) {
      return this.configuredPolicy;
    }
    return { successCount: children.length };
  }
}
