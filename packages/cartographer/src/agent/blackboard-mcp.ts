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
  read: (args: { key: string }) => Promise<McpToolResult>;
  write: (args: { key: string; value: unknown }) => Promise<McpToolResult>;
  keys: (args: Record<string, never>) => Promise<McpToolResult>;
  delete: (args: { key: string }) => Promise<McpToolResult>;
  read_many: (args: { keys: string[] }) => Promise<McpToolResult>;
  write_many: (args: { entries: Record<string, unknown> }) => Promise<McpToolResult>;
  delete_many: (args: { keys: string[] }) => Promise<McpToolResult>;
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
 * | `read` | `key: string` | Read a value by key. Returns the JSON-serialised value, or the string `"undefined"` if the key does not exist. |
 * | `write` | `key: string`, `value: any` | Write any JSON-serialisable value to the blackboard. Returns `"Wrote {key}"` as confirmation. |
 * | `keys` | *(none)* | List all keys currently in scope as a JSON array. |
 * | `delete` | `key: string` | Delete a key from the blackboard. Returns `"Deleted {key}"` as confirmation. |
 * | `read_many` | `keys: string[]` | Read multiple keys in one call. Returns a JSON object mapping each key to its value, or `null` for missing keys. |
 * | `write_many` | `entries: Record<string, any>` | Write multiple key-value pairs in one call. Returns `"Wrote keys: {k1}, {k2}, ..."` as confirmation. |
 * | `delete_many` | `keys: string[]` | Delete multiple keys in one call. Returns `"Deleted keys: {k1}, {k2}, ..."` as confirmation. |
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
 * // write('result', 'done')  →  stores 'agent1:result' in the root map
 * // read('result')           →  reads 'agent1:result' from the root map
 * // keys()                   →  returns ['result'], not ['agent1:result']
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

  const deleteHandler = async (args: { key: string }): Promise<McpToolResult> => {
    scoped.delete(args.key);
    return { content: [{ type: 'text' as const, text: `Deleted ${args.key}` }] };
  };

  const readManyHandler = async (args: { keys: string[] }): Promise<McpToolResult> => {
    const result = scoped.getMany(args.keys);
    // Map undefined → null for JSON serialization (JSON.stringify drops undefined object values)
    const mapped: Record<string, unknown> = {};
    for (const key of args.keys) {
      mapped[key] = result[key] === undefined ? null : result[key];
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(mapped) }] };
  };

  const writeManyHandler = async (args: { entries: Record<string, unknown> }): Promise<McpToolResult> => {
    scoped.setMany(args.entries);
    const keys = Object.keys(args.entries).join(', ');
    return { content: [{ type: 'text' as const, text: `Wrote keys: ${keys}` }] };
  };

  const deleteManyHandler = async (args: { keys: string[] }): Promise<McpToolResult> => {
    scoped.deleteMany(args.keys);
    const keys = args.keys.join(', ');
    return { content: [{ type: 'text' as const, text: `Deleted keys: ${keys}` }] };
  };

  const server = createSdkMcpServer({
    name: 'blackboard',
    version: '1.0.0',
    tools: [
      tool(
        'read',
        'Read a value from the behavior tree blackboard',
        { key: z.string().describe('The key to read') },
        readHandler,
      ),
      tool(
        'write',
        'Write a value to the behavior tree blackboard',
        {
          key: z.string().describe('The key to write'),
          value: z.any().describe('The value to store'),
        },
        writeHandler,
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
        'read_many',
        'Read multiple values from the behavior tree blackboard',
        { keys: z.array(z.string()).describe('The keys to read') },
        readManyHandler,
      ),
      tool(
        'write_many',
        'Write multiple values to the behavior tree blackboard',
        { entries: z.record(z.string(), z.any()).describe('Key-value pairs to write') },
        writeManyHandler,
      ),
      tool(
        'delete_many',
        'Delete multiple keys from the behavior tree blackboard',
        { keys: z.array(z.string()).describe('The keys to delete') },
        deleteManyHandler,
      ),
    ],
  });

  // Attach the raw handler functions for testing purposes. Tests can call
  // these directly without going through the MCP server protocol layer.
  const handlers: BlackboardMcpHandlers = {
    read: readHandler,
    write: writeHandler,
    keys: keysHandler,
    delete: deleteHandler,
    read_many: readManyHandler,
    write_many: writeManyHandler,
    delete_many: deleteManyHandler,
  };

  return Object.assign(server, { handlers });
}
