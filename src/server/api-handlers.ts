import type { ServerResponse } from 'node:http';
import type { BehaviorTree } from '../core/behavior-tree.js';
import type { BTreeNode } from '../types.js';
import { serializeTree, serializeNodeRef } from './serializers.js';
import { jsonResponse, jsonError } from './dashboard-server.js';

export interface StatusState {
  tickCount: number;
  lastStatus: string | null;
  lastDurationMs: number | null;
  startedAt: number;
}

export function handleApiTree(res: ServerResponse, tree: BehaviorTree): void {
  jsonResponse(res, 200, { tree: tree.name, root: serializeTree(tree.root) });
}

export function handleApiStatus(res: ServerResponse, tree: BehaviorTree, state: StatusState): void {
  jsonResponse(res, 200, {
    tree: tree.name,
    tickCount: state.tickCount,
    lastStatus: state.lastStatus,
    lastDurationMs: state.lastDurationMs,
    uptime: Date.now() - state.startedAt,
  });
}

export function handleApiBlackboard(res: ServerResponse, tree: BehaviorTree): void {
  const bb = tree.blackboard;
  const record: Record<string, unknown> = {};
  for (const key of bb.keys()) {
    record[key] = bb.get(key);
  }
  jsonResponse(res, 200, record);
}

export function handleApiNode(res: ServerResponse, tree: BehaviorTree, nodeId: string): void {
  const node = findNodeById(tree.root, nodeId);
  if (!node) {
    jsonError(res, 404, 'Not found');
    return;
  }
  jsonResponse(res, 200, serializeNodeRef(node));
}

function findNodeById(root: BTreeNode, id: string): BTreeNode | undefined {
  const stack: BTreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === id) return node;
    for (const child of node.children) {
      stack.push(child);
    }
  }
  return undefined;
}
