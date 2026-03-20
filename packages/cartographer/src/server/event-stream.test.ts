import { describe, it, expect } from 'vitest';
import { InProcessEventStream } from './event-stream.js';

describe('InProcessEventStream', () => {
  it('push() assigns auto-incrementing string IDs', () => {
    const stream = new InProcessEventStream(100);
    const a = stream.push('node:enter', { node: { id: 'a' } });
    const b = stream.push('node:exit', { node: { id: 'a' } });
    expect(a.id).toBe('1');
    expect(b.id).toBe('2');
    expect(a.event).toBe('node:enter');
    expect(b.event).toBe('node:exit');
  });

  it('push() includes ISO timestamp', () => {
    const stream = new InProcessEventStream(100);
    const entry = stream.push('test', {});
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('latestId starts at "0" and updates on push', () => {
    const stream = new InProcessEventStream(100);
    expect(stream.latestId).toBe('0');
    stream.push('a', {});
    expect(stream.latestId).toBe('1');
    stream.push('b', {});
    expect(stream.latestId).toBe('2');
  });

  it('replaySince("0") returns all events', () => {
    const stream = new InProcessEventStream(100);
    stream.push('a', { x: 1 });
    stream.push('b', { x: 2 });
    const events = stream.replaySince('0');
    expect(events).toHaveLength(2);
  });

  it('replaySince returns events after the given ID', () => {
    const stream = new InProcessEventStream(100);
    stream.push('a', {});
    stream.push('b', {});
    stream.push('c', {});
    const events = stream.replaySince('1');
    expect(events).toHaveLength(2);
    expect(events![0].id).toBe('2');
    expect(events![1].id).toBe('3');
  });

  it('replaySince returns empty array when no events exist', () => {
    const stream = new InProcessEventStream(100);
    expect(stream.replaySince('0')).toEqual([]);
  });

  it('evicts oldest events when capacity exceeded', () => {
    const stream = new InProcessEventStream(3);
    stream.push('a', {});
    stream.push('b', {});
    stream.push('c', {});
    stream.push('d', {});
    const events = stream.replaySince('0');
    expect(events).toHaveLength(3);
    expect(events![0].event).toBe('b');
    expect(events![0].id).toBe('2');
  });

  it('replaySince returns null when requested ID is evicted (buffer gap)', () => {
    const stream = new InProcessEventStream(2);
    stream.push('a', {}); // id=1
    stream.push('b', {}); // id=2
    stream.push('c', {}); // id=3, evicts id=1
    // ID 1 has been evicted — return null to signal a full snapshot is needed
    expect(stream.replaySince('1')).toBeNull();
  });

  it('subscribe() receives pushed events', () => {
    const stream = new InProcessEventStream(100);
    const received: unknown[] = [];
    stream.subscribe((entry) => received.push(entry));
    stream.push('a', { x: 1 });
    stream.push('b', { x: 2 });
    expect(received).toHaveLength(2);
  });

  it('unsubscribe stops receiving events', () => {
    const stream = new InProcessEventStream(100);
    const received: unknown[] = [];
    const unsub = stream.subscribe((entry) => received.push(entry));
    stream.push('a', {});
    unsub();
    stream.push('b', {});
    expect(received).toHaveLength(1);
  });

  it('multiple subscribers all receive events', () => {
    const stream = new InProcessEventStream(100);
    const a: unknown[] = [];
    const b: unknown[] = [];
    stream.subscribe((entry) => a.push(entry));
    stream.subscribe((entry) => b.push(entry));
    stream.push('test', {});
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
