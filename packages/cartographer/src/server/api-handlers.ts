/**
 * REST API request handlers for the {@link ActorServer}.
 *
 * Each handler corresponds to a single HTTP endpoint exposed by the server.
 * Handlers receive an already-matched route and are responsible for serializing
 * the response via the shared {@link jsonResponse} / {@link jsonError} helpers.
 *
 * | Handler                  | Endpoint              | Description                          |
 * | ------------------------ | --------------------- | ------------------------------------ |
 * | {@link handleApiTree}       | `GET /api/tree`       | Full tree structure                  |
 * | {@link handleApiStatus}     | `GET /api/status`     | Tick/cycle counters and uptime       |
 * | {@link handleApiBlackboard} | `GET /api/blackboard` | Current blackboard key-value pairs   |
 * | {@link handleApiNode}       | `GET /api/node/:id`   | Detailed info for a single node      |
 *
 * @module
 */
import type { ServerResponse } from 'node:http';
import type { BehaviorTree } from '../core/behavior-tree.js';
import type { BTreeNode } from '../types.js';
import { AgentNode } from '../nodes/agent.js';
import { serializeTree, serializeNodeRef } from './serializers.js';
import { jsonResponse, jsonError } from './http-utils.js';
import { blackboardToRecord } from './sse-handler.js';

/**
 * Runtime status snapshot maintained by the {@link ActorServer} across ticks.
 *
 * The server updates these counters after each tick completes and passes the
 * current state to {@link handleApiStatus} when the `/api/status` endpoint is
 * called.
 */
export interface StatusState {
  /** Total number of ticks executed since the server started. */
  tickCount: number;

  /**
   * Number of complete tick cycles.
   *
   * A cycle is one full pass of the scheduler interval. In most
   * configurations this equals `tickCount`, but strategies that skip ticks
   * (e.g. when the tree is still RUNNING) can cause the two to diverge.
   */
  cycleCount: number;

  /**
   * The {@link NodeStatus} string returned by the most recent tick, or `null`
   * if no tick has completed yet.
   */
  lastStatus: string | null;

  /**
   * Wall-clock duration of the most recent tick in milliseconds, or `null`
   * if no tick has completed yet.
   */
  lastDurationMs: number | null;

  /** Unix timestamp (ms) when the server was started. Used to derive uptime. */
  startedAt: number;
}

/**
 * Handles `GET /api/tree` — returns the full tree structure.
 *
 * The response contains the tree name and a recursively serialized
 * representation of every node starting from the root. Each node in the
 * response includes its `id`, `name`, `type`, and `children` array.
 *
 * @param res  - The HTTP response to write to.
 * @param tree - The behavior tree instance to serialize.
 *
 * @example Response shape
 * ```json
 * {
 *   "tree": "my-tree",
 *   "root": {
 *     "id": "seq-1",
 *     "name": "MainSequence",
 *     "type": "sequence",
 *     "children": [
 *       { "id": "act-1", "name": "FetchData", "type": "action", "children": [] }
 *     ]
 *   }
 * }
 * ```
 */
export function handleApiTree(res: ServerResponse, tree: BehaviorTree): void {
  jsonResponse(res, 200, { tree: tree.name, root: serializeTree(tree.root) });
}

/**
 * Handles `GET /api/status` — returns runtime health and progress counters.
 *
 * The response includes tick and cycle counts, the result of the last tick,
 * its wall-clock duration, and the server's uptime in milliseconds. This
 * endpoint is designed for lightweight polling by dashboards and monitoring
 * tools.
 *
 * @param res   - The HTTP response to write to.
 * @param tree  - The behavior tree instance (used for its name).
 * @param state - The current {@link StatusState} maintained by the server.
 *
 * @example Response shape
 * ```json
 * {
 *   "tree": "my-tree",
 *   "tickCount": 42,
 *   "cycleCount": 42,
 *   "lastStatus": "SUCCESS",
 *   "lastDurationMs": 128,
 *   "uptime": 300000
 * }
 * ```
 */
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

/**
 * Handles `GET /api/blackboard` — returns the current blackboard state.
 *
 * Serializes every key-value pair stored in the tree's {@link Blackboard} into
 * a flat JSON object. Values that are not natively JSON-serializable (e.g.
 * `Map`, `Set`) are converted to plain representations by
 * {@link blackboardToRecord}.
 *
 * @param res  - The HTTP response to write to.
 * @param tree - The behavior tree whose blackboard will be serialized.
 *
 * @example Response shape
 * ```json
 * {
 *   "user:name": "Alice",
 *   "metrics:requestCount": 17
 * }
 * ```
 */
export function handleApiBlackboard(res: ServerResponse, tree: BehaviorTree): void {
  jsonResponse(res, 200, blackboardToRecord(tree.blackboard));
}

/**
 * Handles `GET /api/node/:id` — returns detailed information for a single node.
 *
 * Performs a depth-first search from the tree root to locate the node matching
 * `nodeId`. If found, the response includes the standard serialized fields
 * (`id`, `name`, `type`) plus type-specific extras:
 *
 * - **AgentNode** — additionally includes `model`, `tools`, and `mcpServers`
 *   extracted from the node's {@link AgentInfo}.
 * - **Composite / Decorator** — additionally includes a `children` array of
 *   serialized child references.
 *
 * Returns a `404` JSON error if no node with the given ID exists in the tree.
 *
 * @param res    - The HTTP response to write to.
 * @param tree   - The behavior tree to search.
 * @param nodeId - The unique ID of the node to look up.
 *
 * @example Response shape (AgentNode with children)
 * ```json
 * {
 *   "id": "agent-1",
 *   "name": "Summarizer",
 *   "type": "agent",
 *   "model": "claude-sonnet-4-6",
 *   "tools": ["web_search"],
 *   "mcpServers": [],
 *   "children": []
 * }
 * ```
 */
export function handleApiNode(res: ServerResponse, tree: BehaviorTree, nodeId: string): void {
  const node = findNodeById(tree.root, nodeId);
  if (!node) {
    jsonError(res, 404, 'Not found');
    return;
  }

  const base = serializeNodeRef(node);
  const detail: Record<string, unknown> = { ...base };

  if (node instanceof AgentNode) {
    const info = node.agentOptions;
    if (info.model) detail.model = info.model;
    detail.tools = info.tools ?? [];
    detail.mcpServers = (info.mcpServers as string[]) ?? [];
  }

  if (node.children.length > 0) {
    detail.children = node.children.map(serializeNodeRef);
  }

  jsonResponse(res, 200, detail);
}

/**
 * Locates a node by its unique ID using an iterative depth-first search.
 *
 * Traverses the tree starting from `root`, visiting children via an explicit
 * stack (no recursion). Returns the first node whose `id` matches, or
 * `undefined` if no match is found.
 *
 * @param root - The root node to begin searching from.
 * @param id   - The unique node ID to find.
 * @returns The matching {@link BTreeNode}, or `undefined` if not present.
 */
export function findNodeById(root: BTreeNode, id: string): BTreeNode | undefined {
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
