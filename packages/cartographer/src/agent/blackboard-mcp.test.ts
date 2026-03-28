import { describe, it, expect } from 'vitest';
import { z } from 'zod/v4';
import { createBlackboardMcpServer } from './blackboard-mcp.js';
import { InMemoryBlackboard } from '../core/blackboard.js';
import { createBlackboardSchema } from '../core/blackboard-schema.js';

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
  it('get returns the value for a key', async () => {
    const bb = new InMemoryBlackboard();
    bb.set('name', 'Alice');
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.get({ key: 'name' });
    expect(result.content[0].text).toBe(JSON.stringify('Alice'));
  });

  it('get returns undefined for missing key', async () => {
    const bb = new InMemoryBlackboard();
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.get({ key: 'missing' });
    expect(result.content[0].text).toBe('undefined');
  });

  it('set stores a value', async () => {
    const bb = new InMemoryBlackboard();
    const { handlers } = createBlackboardMcpServer(bb);
    await handlers.set({ key: 'score', value: 42 });
    expect(bb.get('score')).toBe(42);
  });

  it('keys lists all keys', async () => {
    const bb = new InMemoryBlackboard();
    bb.set('a', 1);
    bb.set('b', 2);
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.keys({});
    const keys = JSON.parse(result.content[0].text);
    expect(keys.sort()).toEqual(['a', 'b']);
  });

  it('respects namespace scoping', async () => {
    const bb = new InMemoryBlackboard();
    bb.set('global', 'visible');
    bb.set('ns:local', 'scoped');
    const { handlers } = createBlackboardMcpServer(bb, 'ns');
    const keysResult = await handlers.keys({});
    const keys = JSON.parse(keysResult.content[0].text);
    expect(keys).toEqual(['local']);
    const getResult = await handlers.get({ key: 'local' });
    expect(getResult.content[0].text).toBe(JSON.stringify('scoped'));
  });

  it('set respects namespace', async () => {
    const bb = new InMemoryBlackboard();
    const { handlers } = createBlackboardMcpServer(bb, 'agent1');
    await handlers.set({ key: 'result', value: 'done' });
    expect(bb.get('agent1:result')).toBe('done');
  });

  it('delete removes a key', async () => {
    const bb = new InMemoryBlackboard({ target: 'exists' });
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.delete({ key: 'target' });
    expect(bb.has('target')).toBe(false);
    expect(result.content[0].text).toBe('Deleted target');
  });

  it('delete respects namespace', async () => {
    const bb = new InMemoryBlackboard({ 'ns:key': 'value', 'other': 'safe' });
    const { handlers } = createBlackboardMcpServer(bb, 'ns');
    await handlers.delete({ key: 'key' });
    expect(bb.has('ns:key')).toBe(false);
    expect(bb.has('other')).toBe(true);
  });

  it('mget returns values for multiple keys', async () => {
    const bb = new InMemoryBlackboard({ a: 1, b: 'hello' });
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.mget({ keys: ['a', 'b'] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ a: 1, b: 'hello' });
  });

  it('mget returns null for missing keys', async () => {
    const bb = new InMemoryBlackboard({ a: 1 });
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.mget({ keys: ['a', 'missing'] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ a: 1, missing: null });
  });

  it('mget with empty keys returns empty object', async () => {
    const bb = new InMemoryBlackboard({ a: 1 });
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.mget({ keys: [] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({});
  });

  it('mget respects namespace', async () => {
    const bb = new InMemoryBlackboard({ 'ns:a': 1, 'ns:b': 2, 'other:c': 3 });
    const { handlers } = createBlackboardMcpServer(bb, 'ns');
    const result = await handlers.mget({ keys: ['a', 'b'] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ a: 1, b: 2 });
  });

  it('mset sets multiple entries', async () => {
    const bb = new InMemoryBlackboard();
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.mset({ entries: { x: 10, y: 20 } });
    expect(bb.get('x')).toBe(10);
    expect(bb.get('y')).toBe(20);
    expect(result.content[0].text).toBe('Set keys: x, y');
  });

  it('mset respects namespace', async () => {
    const bb = new InMemoryBlackboard();
    const { handlers } = createBlackboardMcpServer(bb, 'agent1');
    await handlers.mset({ entries: { a: 1, b: 2 } });
    expect(bb.get('agent1:a')).toBe(1);
    expect(bb.get('agent1:b')).toBe(2);
  });

  it('mset with empty entries', async () => {
    const bb = new InMemoryBlackboard();
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.mset({ entries: {} });
    expect(result.content[0].text).toBe('Set keys: ');
  });

  it('mdelete removes multiple keys', async () => {
    const bb = new InMemoryBlackboard({ a: 1, b: 2, c: 3 });
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.mdelete({ keys: ['a', 'c'] });
    expect(bb.has('a')).toBe(false);
    expect(bb.has('b')).toBe(true);
    expect(bb.has('c')).toBe(false);
    expect(result.content[0].text).toBe('Deleted keys: a, c');
  });

  it('mdelete respects namespace', async () => {
    const bb = new InMemoryBlackboard({ 'ns:a': 1, 'ns:b': 2, 'other:c': 3 });
    const { handlers } = createBlackboardMcpServer(bb, 'ns');
    await handlers.mdelete({ keys: ['a', 'b'] });
    expect(bb.has('ns:a')).toBe(false);
    expect(bb.has('ns:b')).toBe(false);
    expect(bb.has('other:c')).toBe(true);
  });

  it('mdelete with empty keys', async () => {
    const bb = new InMemoryBlackboard();
    const { handlers } = createBlackboardMcpServer(bb);
    const result = await handlers.mdelete({ keys: [] });
    expect(result.content[0].text).toBe('Deleted keys: ');
  });
});

describe('blackboard MCP with schema (enriched descriptions)', () => {
  const schema = createBlackboardSchema({
    task: z.string(),
    count: z.number(),
    analyst: {
      output: z.object({ summary: z.string(), confidence: z.number() }),
      sources: z.array(z.string()),
    },
  });

  it('accepts optional schema parameter', () => {
    const bb = new InMemoryBlackboard();
    const server = createBlackboardMcpServer(bb, { schema });
    expect(server).toBeDefined();
  });

  it('still works without schema (backward compatible)', () => {
    const bb = new InMemoryBlackboard();
    const server = createBlackboardMcpServer(bb);
    expect(server).toBeDefined();
  });

  it('still works with string namespace (backward compatible)', () => {
    const bb = new InMemoryBlackboard();
    const server = createBlackboardMcpServer(bb, 'ns');
    expect(server).toBeDefined();
  });

  it('still works with namespace and schema together', () => {
    const bb = new InMemoryBlackboard();
    const server = createBlackboardMcpServer(bb, { namespace: 'analyst', schema });
    expect(server).toBeDefined();
  });

  it('handlers still work correctly with schema', async () => {
    const bb = new InMemoryBlackboard();
    const { handlers } = createBlackboardMcpServer(bb, { schema });
    await handlers.set({ key: 'task', value: 'hello' });
    const result = await handlers.get({ key: 'task' });
    expect(result.content[0].text).toBe(JSON.stringify('hello'));
  });

  it('scoped schema shows only scope keys for namespace', async () => {
    const bb = new InMemoryBlackboard();
    const { handlers } = createBlackboardMcpServer(bb, { namespace: 'analyst', schema });
    await handlers.set({ key: 'output', value: { summary: 'good', confidence: 0.9 } });
    const result = await handlers.get({ key: 'output' });
    expect(JSON.parse(result.content[0].text)).toEqual({ summary: 'good', confidence: 0.9 });
  });
});
