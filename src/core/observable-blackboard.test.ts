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
});
