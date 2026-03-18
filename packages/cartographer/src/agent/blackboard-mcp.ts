import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import type { Blackboard } from '../types.js';

/**
 * The shape of a successful MCP tool response.
 * The Claude SDK requires tool results to be wrapped in this structure.
 */
interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
}

/**
 * Typed map of the three blackboard tool handler functions.
 *
 * Exposed via the `handlers` property on the server object returned by
 * {@link createBlackboardMcpServer}. Primarily useful for unit testing
 * the tool behaviour without invoking the full MCP server.
 */
interface BlackboardMcpHandlers {
  blackboard_read: (args: { key: string }) => Promise<McpToolResult>;
  blackboard_write: (args: { key: string; value: unknown }) => Promise<McpToolResult>;
  blackboard_keys: (args: Record<string, never>) => Promise<McpToolResult>;
}

/**
 * Create an in-process MCP server that gives Claude read/write access to
 * the behavior tree blackboard.
 *
 * This server is created automatically by {@link AgentNode} and passed to
 * the Claude SDK as `mcpServers: { blackboard: server }`. It does not need
 * to be constructed manually under normal usage.
 *
 * ## Exposed tools
 *
 * Claude can call three tools while the agent node is executing:
 *
 * | Tool | Arguments | Description |
 * |---|---|---|
 * | `blackboard_read` | `key: string` | Read a value by key. Returns the JSON-serialised value, or the string `"undefined"` if the key does not exist. |
 * | `blackboard_write` | `key: string`, `value: any` | Write any JSON-serialisable value to the blackboard. Returns `"Wrote {key}"` as confirmation. |
 * | `blackboard_keys` | *(none)* | List all keys currently in scope as a JSON array. |
 *
 * In `AgentNode`, these tools are made available to Claude via the pattern
 * `allowedTools: ['mcp__blackboard__*']`.
 *
 * ## Namespace isolation
 *
 * When a `namespace` is provided, all three tools operate on a
 * {@link Blackboard.scoped | scoped view} of the blackboard. Claude can
 * only see and modify keys within that namespace — it cannot read or write
 * keys belonging to other nodes. The keys returned by `blackboard_keys`
 * are the unscoped names as seen through the scoped view (i.e. without the
 * `namespace:` prefix).
 *
 * ```
 * // With namespace 'agent1':
 * // blackboard_write('result', 'done')  →  stores 'agent1:result' in the root map
 * // blackboard_read('result')           →  reads 'agent1:result' from the root map
 * // blackboard_keys()                   →  returns ['result'], not ['agent1:result']
 * ```
 *
 * ## Return value
 *
 * Returns the MCP server object with an additional `handlers` property
 * containing the raw handler functions. The handlers are primarily useful
 * for testing tool behaviour in isolation without the MCP protocol layer.
 *
 * @param blackboard - The blackboard to expose via MCP tools.
 * @param namespace - Optional namespace. When provided, all tool operations
 *   are scoped to this namespace prefix.
 */
export function createBlackboardMcpServer(blackboard: Blackboard, namespace?: string) {
  // If a namespace is given, restrict Claude's view to that prefix.
  // Reads and writes outside the namespace are invisible to the agent.
  const scoped = namespace ? blackboard.scoped(namespace) : blackboard;

  const readHandler = async (args: { key: string }): Promise<McpToolResult> => {
    const value = scoped.get(args.key);
    // Return the string literal 'undefined' rather than omitting the field
    // so Claude can distinguish between a missing key and a falsy value.
    const text = value === undefined ? 'undefined' : JSON.stringify(value);
    return { content: [{ type: 'text' as const, text }] };
  };

  const writeHandler = async (args: { key: string; value: unknown }): Promise<McpToolResult> => {
    scoped.set(args.key, args.value);
    return { content: [{ type: 'text' as const, text: `Wrote ${args.key}` }] };
  };

  const keysHandler = async (_args: Record<string, never>): Promise<McpToolResult> => ({
    content: [{ type: 'text' as const, text: JSON.stringify(scoped.keys()) }],
  });

  const server = createSdkMcpServer({
    name: 'blackboard',
    version: '1.0.0',
    tools: [
      tool(
        'blackboard_read',
        'Read a value from the behavior tree blackboard',
        { key: z.string().describe('The key to read') },
        readHandler,
      ),
      tool(
        'blackboard_write',
        'Write a value to the behavior tree blackboard',
        {
          key: z.string().describe('The key to write'),
          value: z.any().describe('The value to store'),
        },
        writeHandler,
      ),
      tool(
        'blackboard_keys',
        'List all keys in the blackboard',
        {},
        keysHandler,
      ),
    ],
  });

  // Attach the raw handler functions for testing purposes. Tests can call
  // these directly without going through the MCP server protocol layer.
  const handlers: BlackboardMcpHandlers = {
    blackboard_read: readHandler,
    blackboard_write: writeHandler,
    blackboard_keys: keysHandler,
  };

  return Object.assign(server, { handlers });
}
