import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSessionStreams } from './session-streams.js';
import type { SSEStreamingApi } from 'hono/streaming';

function mockSseClient(): SSEStreamingApi {
  return { close: vi.fn().mockResolvedValue(undefined) } as unknown as SSEStreamingApi;
}

describe('createSessionStreams', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getOrCreateStream', () => {
    it('creates a stream lazily on first call', () => {
      const handle = createSessionStreams({ streamEvictionMs: 300_000 });
      const stream = handle.getOrCreateStream('session-1');
      expect(stream).toBeDefined();
      expect(stream.latestId).toBe('0');
    });

    it('returns the same stream on repeated calls', () => {
      const handle = createSessionStreams({ streamEvictionMs: 300_000 });
      const a = handle.getOrCreateStream('session-1');
      const b = handle.getOrCreateStream('session-1');
      expect(a).toBe(b);
    });

    it('returns different streams for different sessions', () => {
      const handle = createSessionStreams({ streamEvictionMs: 300_000 });
      const a = handle.getOrCreateStream('session-1');
      const b = handle.getOrCreateStream('session-2');
      expect(a).not.toBe(b);
    });

    it('cancels a pending eviction timer when stream is reused', () => {
      const handle = createSessionStreams({ streamEvictionMs: 5_000 });
      const stream = handle.getOrCreateStream('session-1');

      // Schedule eviction
      handle.scheduleStreamEviction('session-1');

      // Reuse stream before eviction fires — should cancel timer
      const reused = handle.getOrCreateStream('session-1');
      expect(reused).toBe(stream);

      // Advance past eviction window — stream should still exist
      vi.advanceTimersByTime(10_000);
      const stillThere = handle.getOrCreateStream('session-1');
      expect(stillThere).toBe(stream);
    });
  });

  describe('scheduleStreamEviction', () => {
    it('evicts the stream after the configured timeout', () => {
      const handle = createSessionStreams({ streamEvictionMs: 5_000 });
      const original = handle.getOrCreateStream('session-1');

      handle.scheduleStreamEviction('session-1');
      vi.advanceTimersByTime(5_000);

      // After eviction, a new call should produce a fresh stream
      const fresh = handle.getOrCreateStream('session-1');
      expect(fresh).not.toBe(original);
    });

    it('does not evict when SSE clients are still connected', () => {
      const handle = createSessionStreams({ streamEvictionMs: 5_000 });
      const original = handle.getOrCreateStream('session-1');

      // Add an SSE client
      const clients = handle.getOrCreateClientSet('session-1');
      clients.add(mockSseClient());

      handle.scheduleStreamEviction('session-1');
      vi.advanceTimersByTime(10_000);

      // Stream should still be the same instance
      const same = handle.getOrCreateStream('session-1');
      expect(same).toBe(original);
    });

    it('does not evict if SSE client connects after timer is scheduled but before it fires', () => {
      const handle = createSessionStreams({ streamEvictionMs: 5_000 });
      const original = handle.getOrCreateStream('session-1');

      handle.scheduleStreamEviction('session-1');

      // Client connects before timer fires
      const clients = handle.getOrCreateClientSet('session-1');
      clients.add(mockSseClient());

      vi.advanceTimersByTime(5_000);

      const same = handle.getOrCreateStream('session-1');
      expect(same).toBe(original);
    });

    it('is a no-op when streamEvictionMs is 0', () => {
      const handle = createSessionStreams({ streamEvictionMs: 0 });
      const original = handle.getOrCreateStream('session-1');

      handle.scheduleStreamEviction('session-1');
      vi.advanceTimersByTime(600_000);

      const same = handle.getOrCreateStream('session-1');
      expect(same).toBe(original);
    });
  });

  describe('getOrCreateClientSet', () => {
    it('creates a client set lazily', () => {
      const handle = createSessionStreams({ streamEvictionMs: 300_000 });
      const clients = handle.getOrCreateClientSet('session-1');
      expect(clients).toBeInstanceOf(Set);
      expect(clients.size).toBe(0);
    });

    it('returns the same set on repeated calls', () => {
      const handle = createSessionStreams({ streamEvictionMs: 300_000 });
      const a = handle.getOrCreateClientSet('session-1');
      const b = handle.getOrCreateClientSet('session-1');
      expect(a).toBe(b);
    });
  });

  describe('cleanupClientSetIfEmpty', () => {
    it('triggers eviction when the client set is empty', () => {
      const handle = createSessionStreams({ streamEvictionMs: 5_000 });
      const original = handle.getOrCreateStream('session-1');

      // Add then remove a client
      const clients = handle.getOrCreateClientSet('session-1');
      const client = mockSseClient();
      clients.add(client);
      clients.delete(client);

      handle.cleanupClientSetIfEmpty('session-1');
      vi.advanceTimersByTime(5_000);

      const fresh = handle.getOrCreateStream('session-1');
      expect(fresh).not.toBe(original);
    });

    it('does not trigger eviction when clients remain', () => {
      const handle = createSessionStreams({ streamEvictionMs: 5_000 });
      const original = handle.getOrCreateStream('session-1');

      const clients = handle.getOrCreateClientSet('session-1');
      clients.add(mockSseClient());
      clients.add(mockSseClient());

      // Remove one — one still connected
      const iter = clients.values();
      clients.delete(iter.next().value!);

      handle.cleanupClientSetIfEmpty('session-1');
      vi.advanceTimersByTime(10_000);

      const same = handle.getOrCreateStream('session-1');
      expect(same).toBe(original);
    });
  });

  describe('closeSseClients', () => {
    it('closes all connected SSE clients', async () => {
      const handle = createSessionStreams({ streamEvictionMs: 300_000 });
      const c1 = mockSseClient();
      const c2 = mockSseClient();

      handle.getOrCreateClientSet('s1').add(c1);
      handle.getOrCreateClientSet('s2').add(c2);

      await handle.closeSseClients();

      expect(c1.close).toHaveBeenCalled();
      expect(c2.close).toHaveBeenCalled();
    });

    it('clears all streams and timers', async () => {
      const handle = createSessionStreams({ streamEvictionMs: 5_000 });
      const original = handle.getOrCreateStream('session-1');
      handle.scheduleStreamEviction('session-1');

      await handle.closeSseClients();

      // After full cleanup, new calls should produce fresh instances
      const fresh = handle.getOrCreateStream('session-1');
      expect(fresh).not.toBe(original);
    });

    it('cancels pending eviction timers without firing them', async () => {
      const handle = createSessionStreams({ streamEvictionMs: 5_000 });
      handle.getOrCreateStream('session-1');
      handle.scheduleStreamEviction('session-1');

      await handle.closeSseClients();

      // Advance time — no errors, no dangling callbacks
      vi.advanceTimersByTime(10_000);

      // Stream was already cleared by closeSseClients, fresh instance here
      const stream = handle.getOrCreateStream('session-1');
      expect(stream).toBeDefined();
    });
  });
});
