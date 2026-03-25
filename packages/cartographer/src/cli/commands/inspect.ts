import { resolve } from 'node:path';
import type { BTreeNode } from '../../types.js';
import type { RunContext, TreeRunConfig } from '../types.js';

export async function inspectCommand(file: string): Promise<void> {
  const modulePath = resolve(file);
  let factory: (ctx: RunContext) => TreeRunConfig;
  try {
    const mod = await import(modulePath);
    factory = mod.default;
    if (typeof factory !== 'function') {
      process.stderr.write(`Error: ${file} must export a default function\n`);
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`Error loading ${file}: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // Call factory with minimal context
  const ctx: RunContext = { env: { ...process.env }, args: [] };
  let config: TreeRunConfig;
  try {
    config = factory(ctx);
  } catch (err) {
    process.stderr.write(`Error in tree factory: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const root = (config.tree as unknown as { root?: BTreeNode }).root;
  if (!root) {
    // BehaviorTree doesn't expose root publicly — walk via children if available
    process.stderr.write('Error: unable to access tree root for inspection\n');
    process.exit(1);
  }

  // Walk and print
  const stats = { nodeCount: 0, maxDepth: 0, agentNodes: 0 };
  printTree(root, '', true, 0, stats);

  process.stdout.write('\n');
  process.stdout.write(`Nodes: ${stats.nodeCount}  Max depth: ${stats.maxDepth}  Agent nodes: ${stats.agentNodes}\n`);
}

interface TreeStats {
  nodeCount: number;
  maxDepth: number;
  agentNodes: number;
}

function printTree(
  node: BTreeNode,
  prefix: string,
  isLast: boolean,
  depth: number,
  stats: TreeStats,
): void {
  stats.nodeCount++;
  stats.maxDepth = Math.max(stats.maxDepth, depth);

  const typeName = nodeTypeName(node);
  if (typeName === 'agent') stats.agentNodes++;

  const connector = depth === 0 ? '' : isLast ? '└── ' : '├── ';
  const label = `[${typeName}] ${node.name}${decoratorParams(node)}`;
  process.stdout.write(`${prefix}${connector}${label}\n`);

  const children = node.children;
  const childPrefix = depth === 0 ? '' : prefix + (isLast ? '    ' : '│   ');
  for (let i = 0; i < children.length; i++) {
    printTree(children[i], childPrefix, i === children.length - 1, depth + 1, stats);
  }
}

function nodeTypeName(node: BTreeNode): string {
  const name = node.constructor?.name ?? 'node';
  return name.replace(/Node$/, '').toLowerCase() || 'node';
}

function decoratorParams(node: BTreeNode): string {
  const n = node as unknown as Record<string, unknown>;
  const parts: string[] = [];

  // Repeat
  if (typeof n.count === 'number') parts.push(`count=${n.count}`);
  if (n.untilStatus) parts.push(`until=${String(n.untilStatus)}`);

  // Retry
  if (typeof n.maxAttempts === 'number') parts.push(`maxAttempts=${n.maxAttempts}`);
  if (typeof n.delayMs === 'number') parts.push(`delay=${n.delayMs}ms`);

  // Timeout
  if (typeof n.timeoutMs === 'number') parts.push(`timeout=${n.timeoutMs}ms`);

  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}
