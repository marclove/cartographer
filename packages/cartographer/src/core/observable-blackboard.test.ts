import { describe, it, expect, vi } from 'vitest';
import { InMemoryBlackboard } from './blackboard.js';
import { ObservableBlackboard } from './observable-blackboard.js';
import { EventEmitter } from './event-emitter.js';
import type { TreeEvents } from '../types.js';

describe('ObservableBlackboard', () => {
  function setup() {
    const inner = new InMemoryBlackboard();
    const events = new EventEmitter<TreeEvents>();
    const bb = new ObservableBlackboard(inner, events);
    return { inner, events, bb };
  }

  it('emits blackboard:write on set()', () => {
    const { events, bb } = setup();
    const handler = vi.fn();
    events.on('blackboard:write', handler);

    bb.set('foo', 42);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ key: 'foo', value: 42, source: 'blackboard' });
  });

  it('emits blackboard:read on get()', () => {
    const { events, bb } = setup();
    const handler = vi.fn();
    events.on('blackboard:read', handler);

    bb.set('foo', 42);
    bb.get('foo');

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ key: 'foo', value: 42, hit: true, source: 'blackboard' });
  });

  it('emits blackboard:read with hit=false for missing keys', () => {
    const { events, bb } = setup();
    const handler = vi.fn();
    events.on('blackboard:read', handler);

    bb.get('missing');

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ key: 'missing', value: undefined, hit: false, source: 'blackboard' });
  });

  it('scoped() emits blackboard:read with prefixed key', () => {
    const { events, bb } = setup();
    const handler = vi.fn();
    events.on('blackboard:read', handler);

    const scoped = bb.scoped('ns');
    scoped.set('result', 'done');
    scoped.get('result');

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ key: 'ns:result', value: 'done', hit: true, source: 'blackboard' });
  });

  it('emits blackboard:keys on keys()', () => {
    const { events, bb } = setup();
    const handler = vi.fn();
    events.on('blackboard:keys', handler);

    bb.set('a', 1);
    bb.set('b', 2);
    bb.keys();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ keys: ['a', 'b'], source: 'blackboard' });
  });

  it('scoped() emits blackboard:keys with prefixed namespace', () => {
    const { events, bb } = setup();
    const handler = vi.fn();
    events.on('blackboard:keys', handler);

    const scoped = bb.scoped('ns');
    scoped.set('x', 1);
    scoped.keys();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ keys: ['x'], source: 'blackboard' });
  });

  it('delegates get() to inner blackboard', () => {
    const { bb } = setup();
    bb.set('key', 'value');
    expect(bb.get('key')).toBe('value');
  });

  it('delegates has() to inner blackboard', () => {
    const { bb } = setup();
    expect(bb.has('key')).toBe(false);
    bb.set('key', 1);
    expect(bb.has('key')).toBe(true);
  });

  it('delegates delete() to inner blackboard', () => {
    const { bb } = setup();
    bb.set('key', 1);
    bb.delete('key');
    expect(bb.has('key')).toBe(false);
  });

  it('emits blackboard:delete on delete()', () => {
    const { events, bb } = setup();
    const handler = vi.fn();
    events.on('blackboard:delete', handler);

    bb.set('foo', 42);
    bb.delete('foo');

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ key: 'foo', source: 'blackboard' });
  });

  it('scoped() emits blackboard:delete with prefixed key', () => {
    const { events, bb } = setup();
    const handler = vi.fn();
    events.on('blackboard:delete', handler);

    const scoped = bb.scoped('ns');
    scoped.set('key', 1);
    scoped.delete('key');

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ key: 'ns:key', source: 'blackboard' });
  });

  it('delegates keys() to inner blackboard', () => {
    const { bb } = setup();
    bb.set('a', 1);
    bb.set('b', 2);
    expect(bb.keys()).toEqual(['a', 'b']);
  });

  it('scoped() returns an observable wrapper that emits events with prefixed key', () => {
    const { events, bb } = setup();
    const handler = vi.fn();
    events.on('blackboard:write', handler);

    const scoped = bb.scoped('ns');
    scoped.set('result', 'done');

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ key: 'ns:result', value: 'done', source: 'blackboard' });
  });

  it('nested scoped() emits events with fully qualified key', () => {
    const { events, bb } = setup();
    const handler = vi.fn();
    events.on('blackboard:write', handler);

    const nested = bb.scoped('a').scoped('b');
    nested.set('x', 99);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ key: 'a:b:x', value: 99, source: 'blackboard' });
  });

  it('writes through to the inner blackboard', () => {
    const { inner, bb } = setup();
    bb.set('top', 1);
    bb.scoped('ns').set('local', 2);

    expect(inner.get('top')).toBe(1);
    expect(inner.get('ns:local')).toBe(2);
  });

  it('emits blackboard:read per key on getMany()', () => {
    const { events, bb } = setup();
    const handler = vi.fn();
    events.on('blackboard:read', handler);

    bb.set('a', 1);
    bb.set('b', 2);
    const result = bb.getMany(['a', 'b', 'missing']);

    expect(result).toEqual({ a: 1, b: 2, missing: undefined });
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenCalledWith({ key: 'a', value: 1, hit: true, source: 'blackboard' });
    expect(handler).toHaveBeenCalledWith({ key: 'b', value: 2, hit: true, source: 'blackboard' });
    expect(handler).toHaveBeenCalledWith({ key: 'missing', value: undefined, hit: false, source: 'blackboard' });
  });

  it('emits blackboard:write per entry on setMany()', () => {
    const { events, bb } = setup();
    const handler = vi.fn();
    events.on('blackboard:write', handler);

    bb.setMany({ x: 10, y: 20 });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith({ key: 'x', value: 10, source: 'blackboard' });
    expect(handler).toHaveBeenCalledWith({ key: 'y', value: 20, source: 'blackboard' });
  });

  it('setMany delegates before emitting (write-before-emit)', () => {
    const { events, bb } = setup();
    events.on('blackboard:write', ({ key }) => {
      // By the time the event fires, the value should already be in the blackboard
      expect(bb.has(key)).toBe(true);
    });

    bb.setMany({ a: 1, b: 2 });
  });

  it('emits blackboard:delete per key on deleteMany()', () => {
    const { events, bb } = setup();
    const handler = vi.fn();
    events.on('blackboard:delete', handler);

    bb.set('a', 1);
    bb.set('b', 2);
    bb.deleteMany(['a', 'b']);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith({ key: 'a', source: 'blackboard' });
    expect(handler).toHaveBeenCalledWith({ key: 'b', source: 'blackboard' });
  });

  it('scoped() emits bulk events with prefixed keys', () => {
    const { events, bb } = setup();
    const readHandler = vi.fn();
    const writeHandler = vi.fn();
    const deleteHandler = vi.fn();
    events.on('blackboard:read', readHandler);
    events.on('blackboard:write', writeHandler);
    events.on('blackboard:delete', deleteHandler);

    const scoped = bb.scoped('ns');
    scoped.setMany({ a: 1, b: 2 });
    scoped.getMany(['a', 'b']);
    scoped.deleteMany(['a']);

    expect(writeHandler).toHaveBeenCalledWith({ key: 'ns:a', value: 1, source: 'blackboard' });
    expect(writeHandler).toHaveBeenCalledWith({ key: 'ns:b', value: 2, source: 'blackboard' });
    expect(readHandler).toHaveBeenCalledWith({ key: 'ns:a', value: 1, hit: true, source: 'blackboard' });
    expect(readHandler).toHaveBeenCalledWith({ key: 'ns:b', value: 2, hit: true, source: 'blackboard' });
    expect(deleteHandler).toHaveBeenCalledWith({ key: 'ns:a', source: 'blackboard' });
  });

  it('nested scoped() emits bulk events with fully qualified keys', () => {
    const { events, bb } = setup();
    const handler = vi.fn();
    events.on('blackboard:write', handler);

    const nested = bb.scoped('a').scoped('b');
    nested.setMany({ x: 99 });

    expect(handler).toHaveBeenCalledWith({ key: 'a:b:x', value: 99, source: 'blackboard' });
  });

  it('getMany with empty array emits no events', () => {
    const { events, bb } = setup();
    const handler = vi.fn();
    events.on('blackboard:read', handler);

    bb.getMany([]);

    expect(handler).not.toHaveBeenCalled();
  });
});
