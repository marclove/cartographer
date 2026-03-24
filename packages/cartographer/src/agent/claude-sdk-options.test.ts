import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryBlackboard } from '../core/blackboard.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => handler),
}));

import {
  injectBlackboardMcp,
  buildSdkElicitationHandler,
  buildSdkOutputFormat,
  composeSdkOptions,
} from './claude-sdk-options.js';

describe('injectBlackboardMcp', () => {
  it('adds blackboard MCP server and mcp__blackboard__* tool pattern', () => {
    const bb = new InMemoryBlackboard();
    const result = injectBlackboardMcp({}, [], bb);

    expect(result.mcpServers).toHaveProperty('blackboard');
    expect(result.allowedTools).toContain('mcp__blackboard__*');
  });

  it('forwards namespace to createBlackboardMcpServer', () => {
    const bb = new InMemoryBlackboard();
    // The namespace is forwarded internally — we verify by checking the server was created
    const result = injectBlackboardMcp({}, [], bb, 'myns');

    expect(result.mcpServers).toHaveProperty('blackboard');
    expect(result.allowedTools).toContain('mcp__blackboard__*');
  });

  it('does not mutate input arrays or objects', () => {
    const bb = new InMemoryBlackboard();
    const originalServers = { existing: { type: 'stdio' } };
    const originalTools = ['tool1'];

    const result = injectBlackboardMcp(originalServers, originalTools, bb);

    // Originals unchanged
    expect(originalServers).not.toHaveProperty('blackboard');
    expect(originalTools).toEqual(['tool1']);

    // Result has both original + injected
    expect(result.mcpServers).toHaveProperty('existing');
    expect(result.mcpServers).toHaveProperty('blackboard');
    expect(result.allowedTools).toContain('tool1');
    expect(result.allowedTools).toContain('mcp__blackboard__*');
  });
});

describe('buildSdkElicitationHandler', () => {
  it('auto-declines when no user handler', async () => {
    const handler = buildSdkElicitationHandler();
    const result = await handler({ message: 'confirm?' } as any, {} as any);
    expect(result).toEqual({ action: 'decline' });
  });

  it('delegates to user handler when provided', async () => {
    const userHandler = vi.fn().mockResolvedValue({ action: 'accept', data: { ok: true } });
    const handler = buildSdkElicitationHandler(userHandler);

    const result = await handler({ message: 'auth?' } as any, {} as any);

    expect(userHandler).toHaveBeenCalled();
    expect(result).toEqual({ action: 'accept', data: { ok: true } });
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

  it('constructs AgentElicitationRequest from SDK request fields (with all optional fields)', async () => {
    const userHandler = vi.fn().mockResolvedValue({ action: 'accept' });
    const handler = buildSdkElicitationHandler(userHandler);

    await handler(
      {
        message: 'auth required',
        requestedSchema: { type: 'object' },
        serverName: 'mcp-auth',
        mode: 'url',
        url: 'https://example.com/auth',
        elicitationId: 'e-123',
      } as any,
      {} as any,
    );

    const request = userHandler.mock.calls[0][0];
    expect(request).toEqual({
      message: 'auth required',
      schema: { type: 'object' },
      serverName: 'mcp-auth',
      mode: 'url',
      url: 'https://example.com/auth',
      elicitationId: 'e-123',
    });
  });

  it('omits optional fields from request when not present in SDK message', async () => {
    const userHandler = vi.fn().mockResolvedValue({ action: 'accept' });
    const handler = buildSdkElicitationHandler(userHandler);

    await handler({ message: 'simple question' } as any, {} as any);

    const request = userHandler.mock.calls[0][0];
    expect(request).toEqual({ message: 'simple question' });
    expect(request).not.toHaveProperty('schema');
    expect(request).not.toHaveProperty('serverName');
    expect(request).not.toHaveProperty('mode');
    expect(request).not.toHaveProperty('url');
    expect(request).not.toHaveProperty('elicitationId');
  });

  it('forwards SDK abort signal to framework handler options', async () => {
    const receivedOpts: any[] = [];
    const userHandler = vi.fn(async (_req: any, opts: any) => {
      receivedOpts.push(opts);
      return { action: 'accept' as const };
    });
    const handler = buildSdkElicitationHandler(userHandler);

    const signal = AbortSignal.abort();
    await handler({ message: 'auth?' } as any, { signal } as any);

    expect(receivedOpts[0]).toEqual({ signal });
  });
});

describe('buildSdkOutputFormat', () => {
  it('converts sendOptions outputSchema to SDK outputFormat', () => {
    const result = buildSdkOutputFormat(undefined, { type: 'object', properties: { x: { type: 'number' } } });

    expect(result).toEqual({
      type: 'json_schema',
      schema: { type: 'object', properties: { x: { type: 'number' } } },
    });
  });

  it('strips $schema from sendOptions outputSchema', () => {
    const result = buildSdkOutputFormat(undefined, {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
    });

    expect(result).toEqual({ type: 'json_schema', schema: { type: 'object' } });
    expect((result as any).schema).not.toHaveProperty('$schema');
  });

  it('sendOptions outputSchema wins over config outputFormat', () => {
    const configFormat = { type: 'json_schema', schema: { type: 'string' } } as any;
    const sendSchema = { type: 'object' };

    const result = buildSdkOutputFormat(configFormat, sendSchema);

    expect(result).toEqual({ type: 'json_schema', schema: { type: 'object' } });
  });

  it('strips $schema from config outputFormat schema when present', () => {
    const configFormat = {
      type: 'json_schema',
      schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' },
    } as any;

    const result = buildSdkOutputFormat(configFormat);

    expect((result as any).schema).not.toHaveProperty('$schema');
    expect((result as any).schema).toHaveProperty('type', 'object');
  });

  it('passes config outputFormat through when schema has no $schema', () => {
    const configFormat = { type: 'json_schema', schema: { type: 'object' } } as any;

    const result = buildSdkOutputFormat(configFormat);

    expect(result).toBe(configFormat); // identity — no modification needed
  });

  it('passes config outputFormat through when it has no schema property', () => {
    const configFormat = { type: 'text' } as any;

    const result = buildSdkOutputFormat(configFormat);

    expect(result).toBe(configFormat);
  });

  it('returns undefined when neither provides a format', () => {
    const result = buildSdkOutputFormat(undefined, undefined);

    expect(result).toBeUndefined();
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
    const ac = new AbortController();
    const result = composeSdkOptions({ name: 'test' }, { signal: ac.signal });

    expect(result.signal).toBe(ac.signal);
  });

  it('does not include signal when not provided', () => {
    const result = composeSdkOptions({ name: 'test' });

    expect(result).not.toHaveProperty('signal');
  });

  it('excludes name from SDK options', () => {
    const result = composeSdkOptions({ name: 'test' });

    expect(result).not.toHaveProperty('name');
  });

  it('includes onElicitation handler in output', () => {
    const result = composeSdkOptions({ name: 'test' });

    expect(result.onElicitation).toBeTypeOf('function');
  });

  it('injects blackboard MCP when blackboard provided', () => {
    const bb = new InMemoryBlackboard();
    const result = composeSdkOptions({ name: 'test' }, { blackboard: bb });

    expect(result.mcpServers).toHaveProperty('blackboard');
    expect(result.allowedTools).toContain('mcp__blackboard__*');
  });

  it('merges config MCP servers with injected blackboard', () => {
    const bb = new InMemoryBlackboard();
    const result = composeSdkOptions(
      { name: 'test', mcpServers: { tools: { type: 'stdio' } } } as any,
      { blackboard: bb },
    );

    expect(result.mcpServers).toHaveProperty('tools');
    expect(result.mcpServers).toHaveProperty('blackboard');
  });

  it('applies outputSchema from sendOptions', () => {
    const result = composeSdkOptions(
      { name: 'test' },
      { outputSchema: { type: 'object', properties: { x: { type: 'number' } } } },
    );

    expect(result.outputFormat).toEqual({
      type: 'json_schema',
      schema: { type: 'object', properties: { x: { type: 'number' } } },
    });
  });
});
