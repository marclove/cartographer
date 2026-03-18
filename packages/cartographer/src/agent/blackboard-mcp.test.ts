import { describe, it, expect } from 'vitest';
import { createBlackboardMcpServer } from './blackboard-mcp.js';
import { InMemoryBlackboard } from '../core/blackboard.js';

describe('createBlackboardMcpServer', () => {
  it('returns an MCP server object', () => {
    const bb = new InMemoryBlackboard();
    const server = createBlackboardMcpServer(bb);
    expect(server).toBeDefined();
  });

  it('creates a server with the name "blackboard"', () => {
    const bb = new InMemoryBlackboard();
    const server = createBlackboardMcpServer(bb);
    expect(server).toBeTruthy();
  });
});

describe('blackboard MCP tools (unit)', () => {
  it('blackboard_read returns the value for a key', async () => {
    const bb = new InMemoryBlackboard();
    bb.set('name', 'Alice');
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.blackboard_read({ key: 'name' });
    expect(result.content[0].text).toBe(JSON.stringify('Alice'));
  });

  it('blackboard_read returns undefined for missing key', async () => {
    const bb = new InMemoryBlackboard();
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.blackboard_read({ key: 'missing' });
    expect(result.content[0].text).toBe('undefined');
  });

  it('blackboard_write sets a value', async () => {
    const bb = new InMemoryBlackboard();
    const { handlers } = createBlackboardMcpServer(bb);
    await handlers.blackboard_write({ key: 'score', value: 42 });
    expect(bb.get('score')).toBe(42);
  });

  it('blackboard_keys lists all keys', async () => {
    const bb = new InMemoryBlackboard();
    bb.set('a', 1);
    bb.set('b', 2);
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.blackboard_keys({});
    const keys = JSON.parse(result.content[0].text);
    expect(keys.sort()).toEqual(['a', 'b']);
  });

  it('respects namespace scoping', async () => {
    const bb = new InMemoryBlackboard();
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
    const bb = new InMemoryBlackboard();
    const { handlers } = createBlackboardMcpServer(bb, 'agent1');
    await handlers.blackboard_write({ key: 'result', value: 'done' });
    expect(bb.get('agent1:result')).toBe('done');
  });
});
