import { ParallelNode } from '../composites/parallel.js';
import type { BTreeNode } from '../types.js';
import type { SessionConfig } from '../types.js';

/**
 * Validate that no two AgentNodes in resume mode on the same named session
 * can execute concurrently within a ParallelNode.
 *
 * Fork-mode agents are excluded — any number can fork the same session concurrently.
 *
 * @throws {Error} If resume-mode agents on the same session are in different
 *   branches of the same ParallelNode.
 */
export function validateSessionConcurrency(root: BTreeNode): void {
  walkForParallelNodes(root);
}

function walkForParallelNodes(node: BTreeNode): void {
  if (node instanceof ParallelNode) {
    checkParallelBranches(node);
  }
  for (const child of node.children) {
    walkForParallelNodes(child);
  }
}

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

function collectResumeSessions(node: BTreeNode): Set<string> {
  const sessions = new Set<string>();

  const config = getSessionConfig(node);
  if (config && !config.fork) {
    sessions.add(config.name);
  }

  for (const child of node.children) {
    for (const s of collectResumeSessions(child)) {
      sessions.add(s);
    }
  }

  return sessions;
}

/** Duck-type check for AgentNode's sessionConfig getter. */
function getSessionConfig(node: BTreeNode): SessionConfig | null {
  if ('sessionConfig' in node) {
    const config = (node as any).sessionConfig;
    return config != null && typeof config === 'object' ? (config as SessionConfig) : null;
  }
  return null;
}
