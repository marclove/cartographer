import { describe, it, expect } from 'vitest';
import { InMemoryBlackboard } from './blackboard.js';

describe('InMemoryBlackboard', () => {
  it('stores and retrieves values', () => {
    const bb = new InMemoryBlackboard();
    bb.set('key', 42);
    expect(bb.get<number>('key')).toBe(42);
  });

  it('returns undefined for missing keys', () => {
    const bb = new InMemoryBlackboard();
    expect(bb.get('missing')).toBeUndefined();
  });

  it('checks key existence with has()', () => {
    const bb = new InMemoryBlackboard();
    bb.set('key', 'value');
    expect(bb.has('key')).toBe(true);
    expect(bb.has('missing')).toBe(false);
  });

  it('deletes keys', () => {
    const bb = new InMemoryBlackboard();
    bb.set('key', 'value');
    bb.delete('key');
    expect(bb.has('key')).toBe(false);
    expect(bb.get('key')).toBeUndefined();
  });

  it('lists all keys', () => {
    const bb = new InMemoryBlackboard();
    bb.set('a', 1);
    bb.set('b', 2);
    expect(bb.keys().sort()).toEqual(['a', 'b']);
  });

  it('accepts initial data', () => {
    const bb = new InMemoryBlackboard({ x: 10, y: 20 });
    expect(bb.get<number>('x')).toBe(10);
    expect(bb.get<number>('y')).toBe(20);
  });

  it('returns a snapshot via toRecord()', () => {
    const bb = new InMemoryBlackboard();
    bb.set('a', 1);
    bb.set('b', 'hello');
    expect(bb.toRecord()).toEqual({ a: 1, b: 'hello' });
  });
});

describe('Scoped Blackboard', () => {
  it('prefixes keys with namespace', () => {
    const bb = new InMemoryBlackboard();
    const scoped = bb.scoped('agent1');

    scoped.set('result', 'done');
    expect(bb.get('agent1:result')).toBe('done');
    expect(scoped.get<string>('result')).toBe('done');
  });

  it('only lists keys within its namespace', () => {
    const bb = new InMemoryBlackboard();
    bb.set('global', 1);
    bb.set('ns:local', 2);

    const scoped = bb.scoped('ns');
    expect(scoped.keys()).toEqual(['local']);
  });

  it('has() only checks within namespace', () => {
    const bb = new InMemoryBlackboard();
    bb.set('global', 1);
    bb.set('ns:local', 2);

    const scoped = bb.scoped('ns');
    expect(scoped.has('local')).toBe(true);
    expect(scoped.has('global')).toBe(false);
  });

  it('delete() only affects namespaced keys', () => {
    const bb = new InMemoryBlackboard();
    bb.set('ns:key', 'value');
    bb.set('other', 'safe');

    const scoped = bb.scoped('ns');
    scoped.delete('key');

    expect(bb.has('ns:key')).toBe(false);
    expect(bb.has('other')).toBe(true);
  });

  it('supports nested scoping', () => {
    const bb = new InMemoryBlackboard();
    const scoped = bb.scoped('a').scoped('b');

    scoped.set('key', 'nested');
    expect(bb.get('a:b:key')).toBe('nested');
  });

  it('getMany applies namespace prefix', () => {
    const bb = new InMemoryBlackboard({ 'ns:a': 1, 'ns:b': 2, 'other:c': 3 });
    const scoped = bb.scoped('ns');
    const result = scoped.getMany(['a', 'b']);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('setMany applies namespace prefix', () => {
    const bb = new InMemoryBlackboard();
    const scoped = bb.scoped('ns');
    scoped.setMany({ x: 10, y: 20 });
    expect(bb.get('ns:x')).toBe(10);
    expect(bb.get('ns:y')).toBe(20);
  });

  it('deleteMany applies namespace prefix', () => {
    const bb = new InMemoryBlackboard({ 'ns:a': 1, 'ns:b': 2, 'other:c': 3 });
    const scoped = bb.scoped('ns');
    scoped.deleteMany(['a', 'b']);
    expect(bb.has('ns:a')).toBe(false);
    expect(bb.has('ns:b')).toBe(false);
    expect(bb.has('other:c')).toBe(true);
  });

  it('nested scoped getMany applies composed prefix', () => {
    const bb = new InMemoryBlackboard({ 'a:b:key': 42 });
    const nested = bb.scoped('a').scoped('b');
    expect(nested.getMany(['key'])).toEqual({ key: 42 });
  });
});

describe('InMemoryBlackboard bulk operations', () => {
  it('getMany returns values for multiple keys', () => {
    const bb = new InMemoryBlackboard({ a: 1, b: 'hello', c: true });
    const result = bb.getMany(['a', 'b', 'c']);
    expect(result).toEqual({ a: 1, b: 'hello', c: true });
  });

  it('getMany returns undefined for missing keys', () => {
    const bb = new InMemoryBlackboard({ a: 1 });
    const result = bb.getMany(['a', 'missing']);
    expect(result).toEqual({ a: 1, missing: undefined });
  });

  it('getMany with empty array returns empty record', () => {
    const bb = new InMemoryBlackboard({ a: 1 });
    expect(bb.getMany([])).toEqual({});
  });

  it('setMany writes multiple key-value pairs', () => {
    const bb = new InMemoryBlackboard();
    bb.setMany({ x: 10, y: 20, z: 30 });
    expect(bb.get('x')).toBe(10);
    expect(bb.get('y')).toBe(20);
    expect(bb.get('z')).toBe(30);
  });

  it('setMany overwrites existing values', () => {
    const bb = new InMemoryBlackboard({ a: 1 });
    bb.setMany({ a: 99, b: 2 });
    expect(bb.get('a')).toBe(99);
    expect(bb.get('b')).toBe(2);
  });

  it('setMany with empty object is a no-op', () => {
    const bb = new InMemoryBlackboard({ a: 1 });
    bb.setMany({});
    expect(bb.keys()).toEqual(['a']);
  });

  it('deleteMany removes multiple keys', () => {
    const bb = new InMemoryBlackboard({ a: 1, b: 2, c: 3 });
    bb.deleteMany(['a', 'c']);
    expect(bb.has('a')).toBe(false);
    expect(bb.has('b')).toBe(true);
    expect(bb.has('c')).toBe(false);
  });

  it('deleteMany with missing keys is a no-op for those keys', () => {
    const bb = new InMemoryBlackboard({ a: 1 });
    bb.deleteMany(['a', 'nonexistent']);
    expect(bb.has('a')).toBe(false);
  });

  it('deleteMany with empty array is a no-op', () => {
    const bb = new InMemoryBlackboard({ a: 1 });
    bb.deleteMany([]);
    expect(bb.has('a')).toBe(true);
  });
});
