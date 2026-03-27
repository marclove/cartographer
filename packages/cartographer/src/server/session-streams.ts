import type { SSEStreamingApi } from 'hono/streaming';
import { InProcessEventStream } from './event-stream.js';

/**
 * Public API surface returned by {@link createSessionStreams}.
 *
 * Manages the lifecycle of per-session {@link InProcessEventStream} instances
 * and their associated SSE client connections. The handle is designed to be
 * called from HTTP route handlers and the message pipeline — it is **not**
 * responsible for routing or message processing itself.
 */
export interface SessionStreamsHandle {
  /**
   * Return the event stream for a session, creating one if it doesn't exist.
   * If an eviction timer is pending for this session, it is cancelled — the
   * session is considered active again.
   */
  getOrCreateStream(sessionKey: string): InProcessEventStream;
  /**
   * Start a TTL countdown to delete the session's event stream. The timer
   * only fires when no SSE clients are connected. If a client connects (or
   * reconnects) before the timer expires, the eviction is skipped.
   *
   * A no-op when `streamEvictionMs` is `0` (eviction disabled).
   */
  scheduleStreamEviction(sessionKey: string): void;
  /**
   * Return the set of active SSE connections for a session, creating an
   * empty set if none exists. Route handlers add clients to this set when
   * an SSE connection opens, and remove them when it closes.
   */
  getOrCreateClientSet(sessionKey: string): Set<SSEStreamingApi>;
  /**
   * Check whether a session's client set is empty and, if so, remove it
   * and schedule stream eviction. Called by route handlers after an SSE
   * connection closes.
   */
  cleanupClientSetIfEmpty(sessionKey: string): void;
  /**
   * Graceful shutdown: close every active SSE connection, cancel all
   * pending eviction timers, and clear all internal maps. The returned
   * promise resolves once every `SSEStreamingApi.close()` has settled.
   */
  closeSseClients(): Promise<void>;
}

/**
 * Create a session stream manager that tracks per-session event streams and
 * their connected SSE clients.
 *
 * Each session gets an {@link InProcessEventStream} — a ring-buffer-backed
 * event log that supports push, replay, and live subscription. SSE clients
 * subscribe to the stream to receive real-time tree events. When a session
 * has no connected clients and no recent activity, its stream is eligible
 * for eviction after `streamEvictionMs` milliseconds.
 *
 * ### Stream lifecycle
 *
 * ```
 * 1. getOrCreateStream   — lazily creates stream, cancels pending eviction
 * 2. message processed   — pipeline calls scheduleStreamEviction
 * 3. timer fires         — if no SSE clients remain, stream is deleted
 * 4. next request        — getOrCreateStream creates a fresh stream
 * ```
 *
 * Eviction is conservative: the timer checks for connected clients both
 * when scheduled and when it fires, so a client that reconnects during the
 * TTL window keeps the stream alive.
 *
 * @param options.streamEvictionMs - Milliseconds of inactivity before an
 *   idle stream is deleted. Set to `0` to disable eviction entirely
 *   (streams persist for the lifetime of the process).
 *
 * @example
 * ```ts
 * const streams = createSessionStreams({ streamEvictionMs: 300_000 });
 *
 * // In a route handler:
 * const stream = streams.getOrCreateStream(sessionKey);
 * stream.push('node:status', { nodeId: 'abc', status: 'success' });
 *
 * // After message processing:
 * streams.scheduleStreamEviction(sessionKey);
 *
 * // On server shutdown:
 * await streams.closeSseClients();
 * ```
 */
export function createSessionStreams(options: { streamEvictionMs: number }): SessionStreamsHandle {
  const { streamEvictionMs } = options;
  const sessionStreams = new Map<string, InProcessEventStream>();
  const sessionSseClients = new Map<string, Set<SSEStreamingApi>>();
  const streamEvictionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Return the stream for `sessionKey`, creating a new
   * {@link InProcessEventStream} (capacity 500) if one doesn't exist.
   * Cancels any pending eviction timer for this session.
   */
  function getOrCreateStream(sessionKey: string): InProcessEventStream {
    // Cancel any pending eviction — this session is active
    const timer = streamEvictionTimers.get(sessionKey);
    if (timer) {
      clearTimeout(timer);
      streamEvictionTimers.delete(sessionKey);
    }

    let stream = sessionStreams.get(sessionKey);
    if (!stream) {
      stream = new InProcessEventStream(500);
      sessionStreams.set(sessionKey, stream);
    }
    return stream;
  }

  /**
   * Start a delayed eviction for `sessionKey`. Bails out immediately if
   * eviction is disabled (`streamEvictionMs <= 0`) or if SSE clients are
   * still connected. The timer callback also re-checks client count before
   * deleting, guarding against races where a client connects after the
   * timer was scheduled but before it fires.
   */
  function scheduleStreamEviction(sessionKey: string): void {
    if (streamEvictionMs <= 0) return;
    // Don't evict if SSE clients are still connected
    const clients = sessionSseClients.get(sessionKey);
    if (clients && clients.size > 0) return;

    const timer = setTimeout(() => {
      streamEvictionTimers.delete(sessionKey);
      // Only evict if still no SSE clients
      const currentClients = sessionSseClients.get(sessionKey);
      if (!currentClients || currentClients.size === 0) {
        sessionStreams.delete(sessionKey);
      }
    }, streamEvictionMs);
    streamEvictionTimers.set(sessionKey, timer);
  }

  /**
   * Return the mutable set of SSE clients for `sessionKey`, creating an
   * empty set if none exists. Callers add/remove clients directly on the
   * returned set.
   */
  function getOrCreateClientSet(sessionKey: string): Set<SSEStreamingApi> {
    let clients = sessionSseClients.get(sessionKey);
    if (!clients) {
      clients = new Set();
      sessionSseClients.set(sessionKey, clients);
    }
    return clients;
  }

  /**
   * If no SSE clients remain for `sessionKey`, remove the client set from
   * the map and schedule stream eviction. Intended to be called from an
   * SSE connection's `onAbort` handler after the client has been removed
   * from the set.
   */
  function cleanupClientSetIfEmpty(sessionKey: string): void {
    const clients = sessionSseClients.get(sessionKey);
    if (!clients || clients.size === 0) {
      sessionSseClients.delete(sessionKey);
      scheduleStreamEviction(sessionKey);
    }
  }

  /**
   * Graceful shutdown. Closes every active SSE connection (awaiting all
   * `close()` promises in parallel), cancels pending eviction timers, and
   * clears all three internal maps so the handle is inert afterward.
   */
  async function closeSseClients(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const [, clients] of sessionSseClients) {
      for (const client of clients) {
        closePromises.push(client.close());
      }
    }
    await Promise.all(closePromises);
    for (const timer of streamEvictionTimers.values()) {
      clearTimeout(timer);
    }
    sessionSseClients.clear();
    sessionStreams.clear();
    streamEvictionTimers.clear();
  }

  return {
    getOrCreateStream,
    scheduleStreamEviction,
    getOrCreateClientSet,
    cleanupClientSetIfEmpty,
    closeSseClients,
  };
}
