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
 * Typed map of the blackboard tool handler functions.
 *
 * Exposed via the `handlers` property on the server object returned by
 * {@link createBlackboardMcpServer}. Primarily useful for unit testing
 * the tool behaviour without invoking the full MCP server.
 */
interface BlackboardMcpHandlers {
  get: (args: { key: string }) => Promise<McpToolResult>;
  set: (args: { key: string; value: unknown }) => Promise<McpToolResult>;
  keys: (args: Record<string, never>) => Promise<McpToolResult>;
  delete: (args: { key: string }) => Promise<McpToolResult>;
  mget: (args: { keys: string[] }) => Promise<McpToolResult>;
  mset: (args: { entries: Record<string, unknown> }) => Promise<McpToolResult>;
  mdelete: (args: { keys: string[] }) => Promise<McpToolResult>;
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
 * Claude can call seven tools while the agent node is executing:
 *
 * | Tool | Arguments | Description |
 * |---|---|---|
 * | `get` | `key: string` | Get a value by key. Returns the JSON-serialised value, or the string `"undefined"` if the key does not exist. |
 * | `set` | `key: string`, `value: any` | Set any JSON-serialisable value on the blackboard. Returns `"Set {key}"` as confirmation. |
 * | `keys` | *(none)* | List all keys currently in scope as a JSON array. |
 * | `delete` | `key: string` | Delete a key from the blackboard. Returns `"Deleted {key}"` as confirmation. |
 * | `mget` | `keys: string[]` | Get multiple keys in one call. Returns a JSON object mapping each key to its value, or `null` for missing keys. |
 * | `mset` | `entries: Record<string, any>` | Set multiple key-value pairs in one call. Returns `"Set keys: {k1}, {k2}, ..."` as confirmation. |
 * | `mdelete` | `keys: string[]` | Delete multiple keys in one call. Returns `"Deleted keys: {k1}, {k2}, ..."` as confirmation. |
 *
 * In `AgentNode`, these tools are made available to Claude via the pattern
 * `allowedTools: ['mcp__blackboard__*']`.
 *
 * ## Namespace isolation
 *
 * When a `namespace` is provided, all three tools operate on a
 * {@link Blackboard.scoped | scoped view} of the blackboard. Claude can
 * only see and modify keys within that namespace — it cannot read or write
 * keys belonging to other nodes. The keys returned by `keys`
 * are the unscoped names as seen through the scoped view (i.e. without the
 * `namespace:` prefix).
 *
 * ```
 * // With namespace 'agent1':
 * // set('result', 'done')  →  stores 'agent1:result' in the root map
 * // get('result')           →  reads 'agent1:result' from the root map
 * // keys()                  →  returns ['result'], not ['agent1:result']
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

  const getHandler = async (args: { key: string }): Promise<McpToolResult> => {
    const value = scoped.get(args.key);
    // Return the string literal 'undefined' rather than omitting the field
    // so Claude can distinguish between a missing key and a falsy value.
    const text = value === undefined ? 'undefined' : JSON.stringify(value);
    return { content: [{ type: 'text' as const, text }] };
  };

  const setHandler = async (args: { key: string; value: unknown }): Promise<McpToolResult> => {
    scoped.set(args.key, args.value);
    return { content: [{ type: 'text' as const, text: `Set ${args.key}` }] };
  };

  const keysHandler = async (_args: Record<string, never>): Promise<McpToolResult> => ({
    content: [{ type: 'text' as const, text: JSON.stringify(scoped.keys()) }],
  });

  const deleteHandler = async (args: { key: string }): Promise<McpToolResult> => {
    scoped.delete(args.key);
    return { content: [{ type: 'text' as const, text: `Deleted ${args.key}` }] };
  };

  const mgetHandler = async (args: { keys: string[] }): Promise<McpToolResult> => {
    const result = scoped.getMany(args.keys);
    // Map undefined → null for JSON serialization (JSON.stringify drops undefined object values)
    const mapped: Record<string, unknown> = {};
    for (const key of args.keys) {
      mapped[key] = result[key] === undefined ? null : result[key];
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(mapped) }] };
  };

  const msetHandler = async (args: { entries: Record<string, unknown> }): Promise<McpToolResult> => {
    scoped.setMany(args.entries);
    const keys = Object.keys(args.entries).join(', ');
    return { content: [{ type: 'text' as const, text: `Set keys: ${keys}` }] };
  };

  const mdeleteHandler = async (args: { keys: string[] }): Promise<McpToolResult> => {
    scoped.deleteMany(args.keys);
    const keys = args.keys.join(', ');
    return { content: [{ type: 'text' as const, text: `Deleted keys: ${keys}` }] };
  };

  const server = createSdkMcpServer({
    name: 'blackboard',
    version: '1.0.0',
    tools: [
      tool(
        'get',
        'Get a value from the behavior tree blackboard by key',
        { key: z.string().describe('The key to get') },
        getHandler,
      ),
      tool(
        'set',
        'Set a value on the behavior tree blackboard',
        {
          key: z.string().describe('The key to set'),
          value: z.any().describe('The value to store'),
        },
        setHandler,
      ),
      tool(
        'keys',
        'List all keys in the blackboard',
        {},
        keysHandler,
      ),
      tool(
        'delete',
        'Delete a key from the behavior tree blackboard',
        { key: z.string().describe('The key to delete') },
        deleteHandler,
      ),
      tool(
        'mget',
        'Get multiple values from the behavior tree blackboard',
        { keys: z.array(z.string()).describe('The keys to get') },
        mgetHandler,
      ),
      tool(
        'mset',
        'Set multiple values on the behavior tree blackboard',
        { entries: z.record(z.string(), z.any()).describe('Key-value pairs to set') },
        msetHandler,
      ),
      tool(
        'mdelete',
        'Delete multiple keys from the behavior tree blackboard',
        { keys: z.array(z.string()).describe('The keys to delete') },
        mdeleteHandler,
      ),
    ],
  });

  // Attach the raw handler functions for testing purposes. Tests can call
  // these directly without going through the MCP server protocol layer.
  const handlers: BlackboardMcpHandlers = {
    get: getHandler,
    set: setHandler,
    keys: keysHandler,
    delete: deleteHandler,
    mget: mgetHandler,
    mset: msetHandler,
    mdelete: mdeleteHandler,
  };

  return Object.assign(server, { handlers });
}
