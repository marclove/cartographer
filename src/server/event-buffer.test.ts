import { describe, it, expect } from 'vitest';
import { EventBuffer } from './event-buffer.js';

describe('EventBuffer', () => {
  it('stores events with incrementing IDs', () => {
    const buf = new EventBuffer(100);
    buf.push('node:enter', { node: { id: 'a' } });
    buf.push('node:exit', { node: { id: 'a' }, status: 'success' });

    const events = buf.getEventsSince(0);
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe(1);
    expect(events[0].event).toBe('node:enter');
    expect(events[1].id).toBe(2);
    expect(events[1].event).toBe('node:exit');
  });

  it('getEventsSince returns events after the given ID', () => {
    const buf = new EventBuffer(100);
    buf.push('node:enter', { node: { id: 'a' } });
    buf.push('node:exit', { node: { id: 'a' } });
    buf.push('tree:tick', { status: 'success' });

    const events = buf.getEventsSince(1);
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe(2);
    expect(events[1].id).toBe(3);
  });

  it('getEventsSince(0) returns all events', () => {
    const buf = new EventBuffer(100);
    buf.push('a', { x: 1 });
    buf.push('b', { x: 2 });
    expect(buf.getEventsSince(0)).toHaveLength(2);
  });

  it('evicts oldest events when capacity exceeded', () => {
    const buf = new EventBuffer(3);
    buf.push('a', {});
    buf.push('b', {});
    buf.push('c', {});
    buf.push('d', {});

    const events = buf.getEventsSince(0);
    expect(events).toHaveLength(3);
    expect(events[0].event).toBe('b');
    expect(events[0].id).toBe(2);
  });

  it('returns null from getEventsSince when requested ID is evicted', () => {
    const buf = new EventBuffer(2);
    buf.push('a', {});
    buf.push('b', {});
    buf.push('c', {});

    // ID 1 has been evicted — return null to signal a full snapshot is needed
    expect(buf.getEventsSince(1)).toBeNull();
  });

  it('latestId returns the ID of the most recent event', () => {
    const buf = new EventBuffer(100);
    expect(buf.latestId).toBe(0);
    buf.push('a', {});
    expect(buf.latestId).toBe(1);
    buf.push('b', {});
    expect(buf.latestId).toBe(2);
  });
});
