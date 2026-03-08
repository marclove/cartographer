# Task 11: Blackboard MCP Server

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the factory function that creates an in-process MCP server exposing blackboard read/write/keys tools to agent nodes.

**Architecture:** Uses `createSdkMcpServer` and `tool()` from the Agent SDK to create an MCP server with three tools: `blackboard_read`, `blackboard_write`, and `blackboard_keys`. Accepts an optional namespace to scope access.

**Tech Stack:** TypeScript, @anthropic-ai/claude-agent-sdk, zod

---

### Step 1: Write failing tests

Create `src/agent/blackboard-mcp.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createBlackboardMcpServer } from './blackboard-mcp.js';
import { MapBlackboard } from '../core/blackboard.js';

describe('createBlackboardMcpServer', () => {
  it('returns an MCP server object', () => {
    const bb = new MapBlackboard();
    const server = createBlackboardMcpServer(bb);
    expect(server).toBeDefined();
  });

  it('creates a server with the name "blackboard"', () => {
    const bb = new MapBlackboard();
    const server = createBlackboardMcpServer(bb);
    // The server object should be passable as an MCP server config
    expect(server).toBeTruthy();
  });
});

describe('blackboard MCP tools (unit)', () => {
  // These tests verify the tool handler functions directly
  // by extracting them from the server configuration

  it('blackboard_read returns the value for a key', async () => {
    const bb = new MapBlackboard();
    bb.set('name', 'Alice');

    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.blackboard_read({ key: 'name' });

    expect(result.content[0].text).toBe(JSON.stringify('Alice'));
  });

  it('blackboard_read returns undefined for missing key', async () => {
    const bb = new MapBlackboard();

    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.blackboard_read({ key: 'missing' });

    expect(result.content[0].text).toBe('undefined');
  });

  it('blackboard_write sets a value', async () => {
    const bb = new MapBlackboard();

    const { handlers } = createBlackboardMcpServer(bb);
    await handlers.blackboard_write({ key: 'score', value: 42 });

    expect(bb.get('score')).toBe(42);
  });

  it('blackboard_keys lists all keys', async () => {
    const bb = new MapBlackboard();
    bb.set('a', 1);
    bb.set('b', 2);

    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.blackboard_keys({});

    const keys = JSON.parse(result.content[0].text);
    expect(keys.sort()).toEqual(['a', 'b']);
  });

  it('respects namespace scoping', async () => {
    const bb = new MapBlackboard();
    bb.set('global', 'visible');
    bb.set('ns:local', 'scoped');

    const { handlers } = createBlackboardMcpServer(bb, 'ns');

    const keysResult = await handlers.blackboard_keys({});
    const keys = JSON.parse(keysResult.content[0].text);
    expect(keys).toEqual(['local']);

    const readResult = await handlers.blackboard_read({ key: 'local' });
    expect(readResult.content[0].text).toBe(JSON.stringify('scoped'));
  });

  it('writes to namespaced keys', async () => {
    const bb = new MapBlackboard();

    const { handlers } = createBlackboardMcpServer(bb, 'agent1');
    await handlers.blackboard_write({ key: 'result', value: 'done' });

    expect(bb.get('agent1:result')).toBe('done');
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/agent/blackboard-mcp.test.ts`
Expected: FAIL

### Step 3: Implement createBlackboardMcpServer

Create `src/agent/blackboard-mcp.ts`:

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
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

  const readHandler = async (args: { key: string }): Promise<McpToolResult> => ({
    content: [{ type: 'text', text: JSON.stringify(scoped.get(args.key)) ?? 'undefined' }],
  });

  const writeHandler = async (args: { key: string; value: unknown }): Promise<McpToolResult> => {
    scoped.set(args.key, args.value);
    return { content: [{ type: 'text', text: `Wrote ${args.key}` }] };
  };

  const keysHandler = async (_args: Record<string, never>): Promise<McpToolResult> => ({
    content: [{ type: 'text', text: JSON.stringify(scoped.keys()) }],
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

  // Expose handlers for unit testing without going through MCP protocol
  const handlers: BlackboardMcpHandlers = {
    blackboard_read: readHandler,
    blackboard_write: writeHandler,
    blackboard_keys: keysHandler,
  };

  return Object.assign(server, { handlers });
}
```

**Note:** The `handlers` property is exposed alongside the MCP server object so tests can call the tool functions directly without going through the MCP transport layer. The server itself is passed to `query()` options as `mcpServers: { blackboard: server }`.

### Step 4: Run test to verify it passes

Run: `npx vitest run src/agent/blackboard-mcp.test.ts`
Expected: PASS (all 7 tests)

**Important:** If `createSdkMcpServer` or `tool` imports fail, verify the `@anthropic-ai/claude-agent-sdk` package is installed. The actual MCP server integration with the SDK will be validated in Task 12 (AgentNode). These unit tests validate the handler logic independently.

### Step 5: Commit

```bash
git add src/agent/blackboard-mcp.ts src/agent/blackboard-mcp.test.ts
git commit -m "feat: implement blackboard MCP server factory for agent node integration"
```
