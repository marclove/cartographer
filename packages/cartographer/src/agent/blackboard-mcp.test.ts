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

  it('blackboard_delete removes a key', async () => {
    const bb = new InMemoryBlackboard({ target: 'exists' });
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.blackboard_delete({ key: 'target' });
    expect(bb.has('target')).toBe(false);
    expect(result.content[0].text).toBe('Deleted target');
  });

  it('blackboard_delete respects namespace', async () => {
    const bb = new InMemoryBlackboard({ 'ns:key': 'value', 'other': 'safe' });
    const { handlers } = createBlackboardMcpServer(bb, 'ns');
    await handlers.blackboard_delete({ key: 'key' });
    expect(bb.has('ns:key')).toBe(false);
    expect(bb.has('other')).toBe(true);
  });

  it('blackboard_read_many returns values for multiple keys', async () => {
    const bb = new InMemoryBlackboard({ a: 1, b: 'hello' });
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.blackboard_read_many({ keys: ['a', 'b'] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ a: 1, b: 'hello' });
  });

  it('blackboard_read_many returns null for missing keys', async () => {
    const bb = new InMemoryBlackboard({ a: 1 });
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.blackboard_read_many({ keys: ['a', 'missing'] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ a: 1, missing: null });
  });

  it('blackboard_read_many with empty keys returns empty object', async () => {
    const bb = new InMemoryBlackboard({ a: 1 });
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.blackboard_read_many({ keys: [] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({});
  });

  it('blackboard_read_many respects namespace', async () => {
    const bb = new InMemoryBlackboard({ 'ns:a': 1, 'ns:b': 2, 'other:c': 3 });
    const { handlers } = createBlackboardMcpServer(bb, 'ns');
    const result = await handlers.blackboard_read_many({ keys: ['a', 'b'] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ a: 1, b: 2 });
  });

  it('blackboard_write_many writes multiple entries', async () => {
    const bb = new InMemoryBlackboard();
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.blackboard_write_many({ entries: { x: 10, y: 20 } });
    expect(bb.get('x')).toBe(10);
    expect(bb.get('y')).toBe(20);
    expect(result.content[0].text).toBe('Wrote keys: x, y');
  });

  it('blackboard_write_many respects namespace', async () => {
    const bb = new InMemoryBlackboard();
    const { handlers } = createBlackboardMcpServer(bb, 'agent1');
    await handlers.blackboard_write_many({ entries: { a: 1, b: 2 } });
    expect(bb.get('agent1:a')).toBe(1);
    expect(bb.get('agent1:b')).toBe(2);
  });

  it('blackboard_write_many with empty entries', async () => {
    const bb = new InMemoryBlackboard();
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.blackboard_write_many({ entries: {} });
    expect(result.content[0].text).toBe('Wrote keys: ');
  });

  it('blackboard_delete_many removes multiple keys', async () => {
    const bb = new InMemoryBlackboard({ a: 1, b: 2, c: 3 });
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.blackboard_delete_many({ keys: ['a', 'c'] });
    expect(bb.has('a')).toBe(false);
    expect(bb.has('b')).toBe(true);
    expect(bb.has('c')).toBe(false);
    expect(result.content[0].text).toBe('Deleted keys: a, c');
  });

  it('blackboard_delete_many respects namespace', async () => {
    const bb = new InMemoryBlackboard({ 'ns:a': 1, 'ns:b': 2, 'other:c': 3 });
    const { handlers } = createBlackboardMcpServer(bb, 'ns');
    await handlers.blackboard_delete_many({ keys: ['a', 'b'] });
    expect(bb.has('ns:a')).toBe(false);
    expect(bb.has('ns:b')).toBe(false);
    expect(bb.has('other:c')).toBe(true);
  });

  it('blackboard_delete_many with empty keys', async () => {
    const bb = new InMemoryBlackboard();
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.blackboard_delete_many({ keys: [] });
    expect(result.content[0].text).toBe('Deleted keys: ');
  });
});
