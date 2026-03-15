import type { ServerResponse } from 'node:http';
import type { BehaviorTree } from '../core/behavior-tree.js';
import type { BTreeNode } from '../types.js';
import { AgentNode } from '../nodes/agent.js';
import { serializeTree, serializeNodeRef } from './serializers.js';
import { jsonResponse, jsonError } from './http-utils.js';

export interface StatusState {
  tickCount: number;
  cycleCount: number;
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
    cycleCount: state.cycleCount,
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

  const base = serializeNodeRef(node);
  const detail: Record<string, unknown> = { ...base };

  if (node instanceof AgentNode) {
    const config = (node as any).config;
    if (config) {
      const opts = config.options ?? {};
      if (opts.model) detail.model = opts.model;
      detail.tools = opts.allowedTools ?? [];
      const mcpServers = opts.mcpServers ? Object.keys(opts.mcpServers) : [];
      detail.mcpServers = mcpServers;
    }
  }

  if (node.children.length > 0) {
    detail.children = node.children.map(serializeNodeRef);
  }

  jsonResponse(res, 200, detail);
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
