import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import type { Blackboard } from '../types.js';

interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
}

interface BlackboardMcpHandlers {
  blackboard_read: (args: { key: string }) => Promise<McpToolResult>;
  blackboard_write: (args: { key: string; value: unknown }) => Promise<McpToolResult>;
  blackboard_keys: (args: Record<string, never>) => Promise<McpToolResult>;
}

export function createBlackboardMcpServer(blackboard: Blackboard, namespace?: string) {
  const scoped = namespace ? blackboard.scoped(namespace) : blackboard;

  const readHandler = async (args: { key: string }): Promise<McpToolResult> => {
    const value = scoped.get(args.key);
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

  const handlers: BlackboardMcpHandlers = {
    blackboard_read: readHandler,
    blackboard_write: writeHandler,
    blackboard_keys: keysHandler,
  };

  return Object.assign(server, { handlers });
}
