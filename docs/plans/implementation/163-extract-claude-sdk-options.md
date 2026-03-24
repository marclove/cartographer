# Task 163: Extract option-building helpers into `claude-sdk-options.ts`

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the `buildQueryOptions` private method from `ClaudeSDKAgent` into four focused pure functions in a new file, with dedicated unit tests.

**Spec Reference:** `docs/superpowers/specs/2026-03-24-claude-sdk-agent-decomposition-design.md`

**Depends on:** Task 162 (extract claude-sdk-mapper)

---

### Important: Read these files first

- `packages/cartographer/src/agent/claude-sdk-agent.ts` — the `buildQueryOptions()` method (lines 268-331 before task 162, verify current location after that task runs)
- `packages/cartographer/src/agent/claude-sdk-agent.test.ts` — existing tests covering blackboard injection, elicitation, outputSchema, permissionMode, signal
- `packages/cartographer/src/agent/agent.ts` — `AgentSendOptions`, `OnElicitation`, `AgentElicitationRequest` types
- `packages/cartographer/src/agent/blackboard-mcp.ts` — `createBlackboardMcpServer` function

Understand the SDK types used: `Options`, `OnElicitation as SDKOnElicitation`. The `ClaudeSDKAgentConfig` type is `AgentConfig & Partial<Options>`.

---

### Step 1: Write failing tests for option helpers

Create `packages/cartographer/src/agent/claude-sdk-options.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => handler),
}));

import { InMemoryBlackboard } from '../core/blackboard.js';
import {
  injectBlackboardMcp,
  buildSdkElicitationHandler,
  buildSdkOutputFormat,
  composeSdkOptions,
} from './claude-sdk-options.js';

describe('injectBlackboardMcp', () => {
  it('adds blackboard MCP server and tool pattern', () => {
    const mcpServers: Record<string, unknown> = { existing: {} };
    const allowedTools = ['Read'];
    const blackboard = new InMemoryBlackboard();

    const result = injectBlackboardMcp(mcpServers, allowedTools, blackboard);

    expect(result.mcpServers).toHaveProperty('existing');
    expect(result.mcpServers).toHaveProperty('blackboard');
    expect(result.allowedTools).toContain('Read');
    expect(result.allowedTools).toContain('mcp__blackboard__*');
  });

  it('forwards namespace to createBlackboardMcpServer', () => {
    const blackboard = new InMemoryBlackboard();
    const result = injectBlackboardMcp({}, [], blackboard, 'agent1');

    // The blackboard MCP server should be created — we verify it exists
    expect(result.mcpServers).toHaveProperty('blackboard');
    expect(result.allowedTools).toContain('mcp__blackboard__*');
  });

  it('does not mutate the input arrays or objects', () => {
    const mcpServers: Record<string, unknown> = { existing: {} };
    const allowedTools = ['Read'];
    const blackboard = new InMemoryBlackboard();

    injectBlackboardMcp(mcpServers, allowedTools, blackboard);

    expect(Object.keys(mcpServers)).toEqual(['existing']);
    expect(allowedTools).toEqual(['Read']);
  });
});

describe('buildSdkElicitationHandler', () => {
  it('auto-declines when no user handler is provided', async () => {
    const handler = buildSdkElicitationHandler();
    const result = await handler({ message: 'confirm?' } as any, {} as any);

    expect(result).toEqual({ action: 'decline' });
  });

  it('delegates to user handler when provided', async () => {
    const userHandler = vi.fn().mockResolvedValue({ action: 'accept', data: { ok: true } });
    const handler = buildSdkElicitationHandler(userHandler);

    const result = await handler(
      { message: 'confirm?', requestedSchema: { type: 'object' } } as any,
      { signal: undefined } as any,
    );

    expect(result).toEqual({ action: 'accept', data: { ok: true } });
    expect(userHandler).toHaveBeenCalledOnce();
  });

  it('maps framework cancel to SDK decline', async () => {
    const userHandler = vi.fn().mockResolvedValue({ action: 'cancel' });
    const handler = buildSdkElicitationHandler(userHandler);

    const result = await handler({ message: 'confirm?' } as any, {} as any);

    expect(result).toEqual({ action: 'decline' });
  });

  it('passes framework decline through unchanged', async () => {
    const userHandler = vi.fn().mockResolvedValue({ action: 'decline' });
    const handler = buildSdkElicitationHandler(userHandler);

    const result = await handler({ message: 'confirm?' } as any, {} as any);

    expect(result).toEqual({ action: 'decline' });
  });

  it('constructs AgentElicitationRequest from SDK request fields', async () => {
    const userHandler = vi.fn().mockResolvedValue({ action: 'decline' });
    const handler = buildSdkElicitationHandler(userHandler);

    await handler({
      message: 'auth needed',
      requestedSchema: { type: 'object' },
      serverName: 'github',
      mode: 'url',
      url: 'https://auth.example.com',
      elicitationId: 'e-123',
    } as any, { signal: undefined } as any);

    const [request, options] = userHandler.mock.calls[0];
    expect(request).toEqual({
      message: 'auth needed',
      schema: { type: 'object' },
      serverName: 'github',
      mode: 'url',
      url: 'https://auth.example.com',
      elicitationId: 'e-123',
    });
    expect(options).toHaveProperty('signal');
  });

  it('omits optional fields from request when not present in SDK message', async () => {
    const userHandler = vi.fn().mockResolvedValue({ action: 'decline' });
    const handler = buildSdkElicitationHandler(userHandler);

    await handler({ message: 'confirm?' } as any, {} as any);

    const [request] = userHandler.mock.calls[0];
    expect(request).toEqual({ message: 'confirm?' });
    expect(request).not.toHaveProperty('schema');
    expect(request).not.toHaveProperty('serverName');
  });

  it('forwards SDK abort signal to framework handler options', async () => {
    const userHandler = vi.fn().mockResolvedValue({ action: 'accept' });
    const handler = buildSdkElicitationHandler(userHandler);
    const signal = AbortSignal.abort();

    await handler({ message: 'auth?' } as any, { signal } as any);

    const [, options] = userHandler.mock.calls[0];
    expect(options.signal).toBe(signal);
  });
});

describe('buildSdkOutputFormat', () => {
  it('converts sendOptions outputSchema to SDK outputFormat', () => {
    const result = buildSdkOutputFormat(
      undefined,
      { type: 'object', properties: { answer: { type: 'number' } } },
    );

    expect(result).toEqual({
      type: 'json_schema',
      schema: { type: 'object', properties: { answer: { type: 'number' } } },
    });
  });

  it('strips $schema from sendOptions outputSchema', () => {
    const result = buildSdkOutputFormat(
      undefined,
      { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' },
    );

    expect((result as any).schema).not.toHaveProperty('$schema');
    expect((result as any).schema).toHaveProperty('type', 'object');
  });

  it('sendOptions outputSchema wins over config outputFormat', () => {
    const configFormat = { type: 'json_schema', schema: { type: 'string' } };
    const result = buildSdkOutputFormat(
      configFormat,
      { type: 'object' },
    );

    expect((result as any).schema).toEqual({ type: 'object' });
  });

  it('strips $schema from config outputFormat schema when present', () => {
    const configFormat = {
      type: 'json_schema',
      schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' },
    };
    const result = buildSdkOutputFormat(configFormat);

    expect((result as any).schema).not.toHaveProperty('$schema');
    expect((result as any).schema).toHaveProperty('type', 'object');
  });

  it('passes config outputFormat through when schema has no $schema', () => {
    const configFormat = {
      type: 'json_schema',
      schema: { type: 'object', properties: {} },
    };
    const result = buildSdkOutputFormat(configFormat);

    expect(result).toEqual(configFormat);
  });

  it('passes config outputFormat through when it has no schema property', () => {
    const configFormat = { type: 'text' };
    const result = buildSdkOutputFormat(configFormat);

    expect(result).toEqual(configFormat);
  });

  it('returns undefined when neither config nor sendOptions provide a format', () => {
    expect(buildSdkOutputFormat(undefined, undefined)).toBeUndefined();
    expect(buildSdkOutputFormat(undefined)).toBeUndefined();
  });
});

describe('composeSdkOptions', () => {
  it('sets permissionMode to default when not specified', () => {
    const result = composeSdkOptions({ name: 'test' });

    expect(result.permissionMode).toBe('default');
  });

  it('preserves permissionMode when specified in config', () => {
    const result = composeSdkOptions({ name: 'test', permissionMode: 'plan' } as any);

    expect(result.permissionMode).toBe('plan');
  });

  it('forwards abort signal from sendOptions', () => {
    const signal = AbortSignal.abort();
    const result = composeSdkOptions({ name: 'test' }, { signal });

    expect(result.signal).toBe(signal);
  });

  it('does not include signal when not provided', () => {
    const result = composeSdkOptions({ name: 'test' });

    expect(result).not.toHaveProperty('signal');
  });

  it('excludes name from SDK options', () => {
    const result = composeSdkOptions({ name: 'test', model: 'claude-haiku-4-5' } as any);

    expect(result).not.toHaveProperty('name');
    expect(result.model).toBe('claude-haiku-4-5');
  });

  it('includes onElicitation handler in output', () => {
    const result = composeSdkOptions({ name: 'test' });

    expect(result.onElicitation).toBeTypeOf('function');
  });

  it('injects blackboard MCP when blackboard provided in sendOptions', () => {
    const blackboard = new InMemoryBlackboard();
    const result = composeSdkOptions({ name: 'test' }, { blackboard });

    expect(result.mcpServers).toHaveProperty('blackboard');
    expect(result.allowedTools).toContain('mcp__blackboard__*');
  });

  it('merges config MCP servers with injected blackboard', () => {
    const blackboard = new InMemoryBlackboard();
    const result = composeSdkOptions(
      { name: 'test', mcpServers: { tools: {} } } as any,
      { blackboard },
    );

    expect((result.mcpServers as any)).toHaveProperty('tools');
    expect((result.mcpServers as any)).toHaveProperty('blackboard');
  });

  it('applies outputSchema from sendOptions', () => {
    const result = composeSdkOptions(
      { name: 'test' },
      { outputSchema: { type: 'object' } },
    );

    expect(result.outputFormat).toEqual({
      type: 'json_schema',
      schema: { type: 'object' },
    });
  });
});
```

- [ ] **Step 1a: Run tests to verify they fail**

Run: `pnpm --filter cartographer exec vitest run src/agent/claude-sdk-options.test.ts`

Expected: FAIL — module `./claude-sdk-options.js` does not exist.

---

### Step 2: Create `claude-sdk-options.ts`

Create `packages/cartographer/src/agent/claude-sdk-options.ts`.

Extract the logic from `ClaudeSDKAgent.buildQueryOptions()` into four functions. The code below is the direct extraction — each function takes over a section of the original method.

```ts
import type { Options, OnElicitation as SDKOnElicitation } from '@anthropic-ai/claude-agent-sdk';
import type { Blackboard } from '../types.js';
import type { AgentConfig, AgentSendOptions, AgentElicitationRequest, OnElicitation } from './agent.js';
import { createBlackboardMcpServer } from './blackboard-mcp.js';

/**
 * Configuration for a ClaudeSDKAgent.
 * Flat intersection of AgentConfig and SDK Options — all SDK options
 * sit at the top level alongside `name`.
 */
export type ClaudeSDKAgentConfig = AgentConfig & Partial<Options>;

/**
 * Inject the blackboard MCP server into copies of the MCP servers map
 * and allowed tools array. Does not mutate the inputs.
 */
export function injectBlackboardMcp(
  mcpServers: Record<string, unknown>,
  allowedTools: string[],
  blackboard: Blackboard,
  namespace?: string,
): { mcpServers: Record<string, unknown>; allowedTools: string[] } {
  return {
    mcpServers: {
      ...mcpServers,
      blackboard: createBlackboardMcpServer(blackboard, namespace),
    },
    allowedTools: [...allowedTools, 'mcp__blackboard__*'],
  };
}

/**
 * Build an SDK-compatible elicitation handler that always responds.
 *
 * Maps framework AgentElicitationRequest/Response types to SDK types.
 * Framework `cancel` maps to SDK `decline`. If no user handler is provided,
 * auto-declines silently (framework-level notification is handled by
 * wrapElicitation in sdk-helpers.ts).
 */
export function buildSdkElicitationHandler(
  handler?: OnElicitation,
): SDKOnElicitation {
  return async (request, opts) => {
    const elicitationRequest: AgentElicitationRequest = {
      message: request.message,
      ...(request.requestedSchema && { schema: request.requestedSchema as Record<string, unknown> }),
      ...(request.serverName && { serverName: request.serverName }),
      ...(request.mode && { mode: request.mode }),
      ...(request.url && { url: request.url }),
      ...(request.elicitationId && { elicitationId: request.elicitationId }),
    };
    if (handler) {
      const response = await handler(elicitationRequest, { signal: opts.signal });
      if (response.action === 'cancel') return { action: 'decline' as const };
      return response;
    }
    return { action: 'decline' as const };
  };
}

/**
 * Resolve the output format from per-call outputSchema or config outputFormat.
 *
 * sendOptions.outputSchema always destructures $schema out and rebuilds as
 * { type: 'json_schema', schema }. Config outputFormat only strips $schema
 * when it is actually present, leaving the format untouched otherwise.
 */
export function buildSdkOutputFormat(
  configFormat?: unknown,
  sendOptionsSchema?: Record<string, unknown>,
): unknown | undefined {
  if (sendOptionsSchema) {
    const { $schema, ...schema } = sendOptionsSchema;
    return { type: 'json_schema', schema } as any;
  }
  if (configFormat && typeof configFormat === 'object' && 'schema' in configFormat) {
    const { $schema, ...schema } = (configFormat as any).schema as Record<string, unknown>;
    if ($schema) {
      return { ...configFormat, schema } as typeof configFormat;
    }
  }
  return configFormat;
}

/**
 * Compose the full SDK Options object from agent config and per-call send options.
 *
 * Orchestrates the three helpers above, spreads remaining config options,
 * sets the permissionMode default, and forwards the abort signal.
 */
export function composeSdkOptions(
  config: ClaudeSDKAgentConfig,
  sendOptions?: AgentSendOptions,
): Record<string, unknown> {
  const { name: _name, ...sdkConfig } = config;
  const userOptions = sdkConfig as Partial<Options>;

  // Build MCP servers and allowed tools
  let mcpServers: Record<string, unknown> = { ...userOptions.mcpServers };
  let allowedTools = [...(userOptions.allowedTools ?? [])];

  if (sendOptions?.blackboard) {
    const injected = injectBlackboardMcp(
      mcpServers,
      allowedTools,
      sendOptions.blackboard,
      sendOptions.blackboardNamespace,
    );
    mcpServers = injected.mcpServers;
    allowedTools = injected.allowedTools;
  }

  // Elicitation handler
  const onElicitation = buildSdkElicitationHandler(sendOptions?.onElicitation);

  // Output format
  const outputFormat = buildSdkOutputFormat(userOptions.outputFormat, sendOptions?.outputSchema);

  // Strip consumed fields from user options before spreading
  const { onElicitation: _e, mcpServers: _m, allowedTools: _a, outputFormat: _o, ...restOptions } = userOptions;

  return {
    ...restOptions,
    mcpServers,
    allowedTools,
    permissionMode: restOptions.permissionMode ?? 'default',
    ...(outputFormat && { outputFormat }),
    onElicitation,
    ...(sendOptions?.signal && { signal: sendOptions.signal }),
  };
}
```

- [ ] **Step 2a: Run the new tests to verify they pass**

Run: `pnpm --filter cartographer exec vitest run src/agent/claude-sdk-options.test.ts`

Expected: All pass.

---

### Step 3: Update `ClaudeSDKAgent` to use `composeSdkOptions`

In `packages/cartographer/src/agent/claude-sdk-agent.ts`:

1. Replace the `ClaudeSDKAgentConfig` type definition with a re-export from the new file:
   ```ts
   import { composeSdkOptions } from './claude-sdk-options.js';
   export type { ClaudeSDKAgentConfig } from './claude-sdk-options.js';
   ```
2. Remove the entire `private buildQueryOptions(...)` method (including JSDoc).
3. Remove SDK imports no longer needed: `Options`, `SDKOnElicitation`. Keep only what `_createSendIterator` still needs (the `query` function import and `SDKSystemMessage` for the init check).
4. Remove the `createBlackboardMcpServer` import (now used only by `claude-sdk-options.ts`).
5. Remove the `AgentElicitationRequest` import (now used only by `claude-sdk-options.ts`).
6. In `_createSendIterator`, change `this.buildQueryOptions(options)` to `composeSdkOptions(this.config, options)`.

**Important:** The `config` field is `private readonly`. `composeSdkOptions` receives it as a parameter. Verify `this.config` is accessible from within `_createSendIterator` (it is — it's a private field accessed within the class).

- [ ] **Step 3a: Run existing tests to verify nothing broke**

Run: `pnpm --filter cartographer exec vitest run src/agent/claude-sdk-agent.test.ts`

Expected: All pass.

- [ ] **Step 3b: Run full package tests**

Run: `pnpm --filter cartographer test`

Expected: All pass.

- [ ] **Step 3c: Typecheck**

Run: `pnpm typecheck`

Expected: Clean.

---

### Step 4: Verify the slimmed-down class

After both tasks 162 and 163, `claude-sdk-agent.ts` should contain only:

- Constructor (reserved name validation, stores config)
- State fields (`_lastSessionId`, `_privateSessionId`, `_activeQuery`, `_closed`)
- `send()` / `_createSendIterator()` — orchestration using imported `composeSdkOptions` and `mapSdkMessage`
- `_dispatchMapped()` — generator helper
- `getInfo()` — metadata
- `close()` — lifecycle
- `sessionId` getter

The file should be approximately 100-120 lines of logic. Verify by scanning the file — no message-mapping switch statement, no option-building logic, no elicitation wiring, no MCP injection.

---

### Step 5: Commit

```bash
git add packages/cartographer/src/agent/claude-sdk-options.ts \
       packages/cartographer/src/agent/claude-sdk-options.test.ts \
       packages/cartographer/src/agent/claude-sdk-agent.ts
git commit -m "refactor(agent): extract option-building helpers into claude-sdk-options.ts"
```
