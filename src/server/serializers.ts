import type { BTreeNode, TreeEvents } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { ConditionNode } from '../nodes/condition.js';
import { AgentNode } from '../nodes/agent.js';
import { SequenceNode } from '../composites/sequence.js';
import { SelectorNode } from '../composites/selector.js';
import { ParallelNode } from '../composites/parallel.js';

export interface SerializedNodeRef {
  id: string;
  name: string;
  type: string;
}

export interface SerializedTreeNode extends SerializedNodeRef {
  children: SerializedTreeNode[];
}

export function getNodeType(node: BTreeNode): string {
  if (node instanceof ActionNode) return 'action';
  if (node instanceof ConditionNode) return 'condition';
  if (node instanceof AgentNode) return 'agent';
  if (node instanceof SequenceNode) return 'sequence';
  if (node instanceof SelectorNode) return 'selector';
  if (node instanceof ParallelNode) return 'parallel';
  if (node.children.length === 1) return 'decorator';
  return 'unknown';
}

export function serializeNodeRef(node: BTreeNode): SerializedNodeRef {
  return { id: node.id, name: node.name, type: getNodeType(node) };
}

export function serializeTree(node: BTreeNode): SerializedTreeNode {
  return {
    ...serializeNodeRef(node),
    children: node.children.map(serializeTree),
  };
}

export function serializeEvent<K extends keyof TreeEvents>(
  event: K,
  data: TreeEvents[K],
): Record<string, unknown> {
  const d = data as any;

  if (event === 'node:enter') {
    return { node: serializeNodeRef(d.node) };
  }
  if (event === 'node:exit') {
    return { node: serializeNodeRef(d.node), status: d.status, durationMs: d.durationMs };
  }
  if (event === 'node:error') {
    return { node: serializeNodeRef(d.node), error: d.error.message };
  }
  if (event === 'agent:prompt') {
    return { nodeId: d.node.id, prompt: d.prompt };
  }
  if (event === 'agent:thinking') {
    return { nodeId: d.node.id, text: d.thinking };
  }
  if (event === 'agent:text') {
    return { nodeId: d.node.id, text: d.text };
  }
  if (event === 'agent:tool_use') {
    return { nodeId: d.node.id, tool: d.tool, input: d.input };
  }
  if (event === 'agent:response') {
    return { nodeId: d.node.id, result: d.result, cost: d.cost, modelUsage: d.modelUsage };
  }
  if (event === 'agent:error') {
    return { nodeId: d.node.id, subtype: d.subtype, errors: d.errors, permissionDenials: d.permissionDenials, cost: d.cost, modelUsage: d.modelUsage };
  }
  if (event === 'agent:message') {
    return { nodeId: d.node.id, message: d.message };
  }
  if (event === 'agent:tool_progress') {
    return { nodeId: d.node.id, toolUseId: d.toolUseId, toolName: d.toolName, elapsedSeconds: d.elapsedSeconds };
  }
  if (event === 'agent:init') {
    return { nodeId: d.node.id, sessionId: d.sessionId, model: d.model, tools: d.tools, mcpServers: d.mcpServers };
  }
  if (event === 'agent:status') {
    return { nodeId: d.node.id, status: d.status };
  }
  if (event === 'agent:rate_limit') {
    return { nodeId: d.node.id, info: d.info };
  }
  if (event === 'agent:stream') {
    return { nodeId: d.node.id, event: d.event };
  }
  if (event === 'agent:elicitation_declined') {
    return { nodeId: d.node.id, request: d.request };
  }
  if (event === 'strategy:decision') {
    return { compositeId: d.composite.id, strategy: d.strategy, decision: d.decision };
  }
  return { ...d };
}
