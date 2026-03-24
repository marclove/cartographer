import { ParallelNode } from '../composites/parallel.js';
import type { BTreeNode } from '../types.js';
import type { SessionConfig } from '../types.js';

/**
 * Validate that no two AgentNodes in resume mode on the same named session
 * can execute concurrently within a ParallelNode.
 *
 * Resume-mode agents append messages to a shared conversation, so running
 * two of them concurrently on the same session would produce interleaved,
 * unpredictable conversation state. This validation runs at tree construction
 * time (called by {@link BehaviorTree}'s constructor) to catch these conflicts
 * early rather than at runtime.
 *
 * Fork-mode agents (`session.fork: true` or a named fork string) are excluded
 * from this check — any number of agents can fork the same session concurrently
 * because each fork creates an independent conversation branch.
 *
 * The check walks the entire tree looking for ParallelNode instances, then
 * compares resume-session names across each parallel branch pair. Agents in
 * sequential composites (Sequence, Selector) are safe because they never
 * execute simultaneously.
 *
 * @param root - The root node of the behavior tree to validate.
 * @throws {Error} If resume-mode agents on the same named session appear in
 *   different branches of the same ParallelNode.
 */
export function validateSessionConcurrency(root: BTreeNode): void {
  walkForParallelNodes(root);
}

/**
 * Recursively walk the tree to find all ParallelNode instances and
 * validate their branches for session concurrency conflicts.
 *
 * @param node - The current node being visited during traversal.
 */
function walkForParallelNodes(node: BTreeNode): void {
  if (node instanceof ParallelNode) {
    checkParallelBranches(node);
  }
  for (const child of node.children) {
    walkForParallelNodes(child);
  }
}

/**
 * Check a single ParallelNode for session concurrency conflicts.
 *
 * Collects the set of resume-mode session names from each branch, then
 * compares every branch pair. If any session name appears in two or more
 * branches, those agents would execute concurrently on the same conversation,
 * which is not allowed.
 *
 * @param parallel - The ParallelNode whose branches are being validated.
 * @throws {Error} If the same resume-mode session name appears in multiple branches.
 */
function checkParallelBranches(parallel: BTreeNode): void {
  const branchSessions: Set<string>[] = parallel.children.map((child) =>
    collectResumeSessions(child),
  );

  for (let i = 0; i < branchSessions.length; i++) {
    for (let j = i + 1; j < branchSessions.length; j++) {
      for (const session of branchSessions[i]) {
        if (branchSessions[j].has(session)) {
          throw new Error(
            `Session concurrency conflict: session "${session}" is resumed in multiple branches of ParallelNode "${parallel.name}". ` +
            `Use fork mode for agents that need concurrent access to the same session.`,
          );
        }
      }
    }
  }
}

/**
 * Recursively collect all resume-mode session names from a subtree.
 *
 * Visits the given node and all its descendants, returning the set of named
 * sessions that are configured in resume mode (i.e., `fork` is not set).
 * Fork-mode sessions are excluded because they create independent conversation
 * branches and are safe to run concurrently.
 *
 * @param node - The root of the subtree to scan.
 * @param into - Accumulator set; avoids per-node allocations during recursion.
 * @returns A set of session names used in resume mode within this subtree.
 */
function collectResumeSessions(node: BTreeNode, into: Set<string> = new Set()): Set<string> {
  const config = getSessionConfig(node);
  if (config && !config.fork) {
    into.add(config.name);
  }

  for (const child of node.children) {
    collectResumeSessions(child, into);
  }

  return into;
}

/**
 * Extract the session configuration from a node, if present.
 *
 * Uses a duck-type check for the `sessionConfig` property rather than
 * importing AgentNode directly, avoiding a circular dependency between
 * the core validation module and the nodes package.
 *
 * @param node - Any behavior tree node.
 * @returns The node's {@link SessionConfig} if it has one, or `null` otherwise.
 */
function getSessionConfig(node: BTreeNode): SessionConfig | null {
  if ('sessionConfig' in node) {
    const config = (node as any).sessionConfig;
    return config != null && typeof config === 'object' ? (config as SessionConfig) : null;
  }
  return null;
}
