import { describe, it, expect } from 'vitest';
import { MapBlackboard } from './blackboard.js';

describe('MapBlackboard', () => {
  it('stores and retrieves values', () => {
    const bb = new MapBlackboard();
    bb.set('key', 42);
    expect(bb.get<number>('key')).toBe(42);
  });

  it('returns undefined for missing keys', () => {
    const bb = new MapBlackboard();
    expect(bb.get('missing')).toBeUndefined();
  });

  it('checks key existence with has()', () => {
    const bb = new MapBlackboard();
    bb.set('key', 'value');
    expect(bb.has('key')).toBe(true);
    expect(bb.has('missing')).toBe(false);
  });

  it('deletes keys', () => {
    const bb = new MapBlackboard();
    bb.set('key', 'value');
    bb.delete('key');
    expect(bb.has('key')).toBe(false);
    expect(bb.get('key')).toBeUndefined();
  });

  it('lists all keys', () => {
    const bb = new MapBlackboard();
    bb.set('a', 1);
    bb.set('b', 2);
    expect(bb.keys().sort()).toEqual(['a', 'b']);
  });

  it('accepts initial data', () => {
    const bb = new MapBlackboard({ x: 10, y: 20 });
    expect(bb.get<number>('x')).toBe(10);
    expect(bb.get<number>('y')).toBe(20);
  });

  it('returns a snapshot via toRecord()', () => {
    const bb = new MapBlackboard();
    bb.set('a', 1);
    bb.set('b', 'hello');
    expect(bb.toRecord()).toEqual({ a: 1, b: 'hello' });
  });
});

describe('Scoped Blackboard', () => {
  it('prefixes keys with namespace', () => {
    const bb = new MapBlackboard();
    const scoped = bb.scoped('agent1');

    scoped.set('result', 'done');
    expect(bb.get('agent1:result')).toBe('done');
    expect(scoped.get<string>('result')).toBe('done');
  });

  it('only lists keys within its namespace', () => {
    const bb = new MapBlackboard();
    bb.set('global', 1);
    bb.set('ns:local', 2);

    const scoped = bb.scoped('ns');
    expect(scoped.keys()).toEqual(['local']);
  });

  it('has() only checks within namespace', () => {
    const bb = new MapBlackboard();
    bb.set('global', 1);
    bb.set('ns:local', 2);

    const scoped = bb.scoped('ns');
    expect(scoped.has('local')).toBe(true);
    expect(scoped.has('global')).toBe(false);
  });

  it('delete() only affects namespaced keys', () => {
    const bb = new MapBlackboard();
    bb.set('ns:key', 'value');
    bb.set('other', 'safe');

    const scoped = bb.scoped('ns');
    scoped.delete('key');

    expect(bb.has('ns:key')).toBe(false);
    expect(bb.has('other')).toBe(true);
  });

  it('supports nested scoping', () => {
    const bb = new MapBlackboard();
    const scoped = bb.scoped('a').scoped('b');

    scoped.set('key', 'nested');
    expect(bb.get('a:b:key')).toBe('nested');
  });
});
