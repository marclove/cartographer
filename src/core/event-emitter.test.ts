import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from './event-emitter.js';

interface TestEvents {
  'test:foo': { value: number };
  'test:bar': { message: string };
}

describe('EventEmitter', () => {
  it('calls listener when event is emitted', () => {
    const emitter = new EventEmitter<TestEvents>();
    const listener = vi.fn();

    emitter.on('test:foo', listener);
    emitter.emit('test:foo', { value: 42 });

    expect(listener).toHaveBeenCalledWith({ value: 42 });
  });

  it('supports multiple listeners for the same event', () => {
    const emitter = new EventEmitter<TestEvents>();
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    emitter.on('test:foo', listener1);
    emitter.on('test:foo', listener2);
    emitter.emit('test:foo', { value: 1 });

    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();
  });

  it('does not call listeners for other events', () => {
    const emitter = new EventEmitter<TestEvents>();
    const fooListener = vi.fn();
    const barListener = vi.fn();

    emitter.on('test:foo', fooListener);
    emitter.on('test:bar', barListener);
    emitter.emit('test:foo', { value: 1 });

    expect(fooListener).toHaveBeenCalledOnce();
    expect(barListener).not.toHaveBeenCalled();
  });

  it('removes a specific listener with off()', () => {
    const emitter = new EventEmitter<TestEvents>();
    const listener = vi.fn();

    emitter.on('test:foo', listener);
    emitter.off('test:foo', listener);
    emitter.emit('test:foo', { value: 1 });

    expect(listener).not.toHaveBeenCalled();
  });

  it('removes all listeners with removeAllListeners()', () => {
    const emitter = new EventEmitter<TestEvents>();
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    emitter.on('test:foo', listener1);
    emitter.on('test:bar', listener2);
    emitter.removeAllListeners();
    emitter.emit('test:foo', { value: 1 });
    emitter.emit('test:bar', { message: 'hello' });

    expect(listener1).not.toHaveBeenCalled();
    expect(listener2).not.toHaveBeenCalled();
  });

  it('does not throw when emitting with no listeners', () => {
    const emitter = new EventEmitter<TestEvents>();
    expect(() => emitter.emit('test:foo', { value: 1 })).not.toThrow();
  });

  it('does not throw when removing a listener that was never added', () => {
    const emitter = new EventEmitter<TestEvents>();
    const listener = vi.fn();
    expect(() => emitter.off('test:foo', listener)).not.toThrow();
  });
});
