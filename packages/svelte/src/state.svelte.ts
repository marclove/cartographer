import type { CartographerClient } from '@cartographer/client';
import type { TreeStatusInfo, ConnectionStatus } from './types.js';

/**
 * Internal reactive state container that bridges SSE events from a
 * {@link CartographerClient} into Svelte 5 reactivity via `$state` runes.
 *
 * Not intended for direct instantiation in application code — use the
 * `CartographerProvider` component instead. Exposed publicly only through
 * {@link createTestContext} for unit-testing scenarios.
 */
export class CartographerState {
  /** Current SSE connection lifecycle status. Starts as `'connecting'`. */
  connectionStatus = $state<ConnectionStatus>('connecting');

  /** Reactive key-value map of the current blackboard state. Replaced (not mutated) on each update. */
  blackboardEntries = $state<Record<string, unknown>>({});

  /** Per-key write counters. Incremented each time a `blackboard:write` event updates a given key. */
  blackboardVersions = $state<Record<string, number>>({});

  /** Monotonically increasing counter bumped on every blackboard change (snapshot or individual write). */
  globalVersion = $state(0);

  /** Latest tree tick result, or `null` before the first `tree:tick` event (and after a snapshot reset). */
  treeStatus = $state<TreeStatusInfo | null>(null);

  /**
   * Registers SSE event handlers on the given client and begins updating
   * reactive state in response to `snapshot`, `blackboard:write`,
   * `tree:tick`, and `connection:error` events.
   *
   * @param client - A connected {@link CartographerClient} instance.
   * @returns A cleanup function that detaches all listeners and sets
   *          {@link connectionStatus} to `'disconnected'`.
   */
  attach(client: CartographerClient): () => void {
    const onSnapshot = (data: unknown) => {
      const d = data as { blackboard: Record<string, unknown> };
      this.blackboardEntries = { ...d.blackboard };
      const versions: Record<string, number> = {};
      for (const key of Object.keys(d.blackboard)) {
        versions[key] = 1;
      }
      this.blackboardVersions = versions;
      this.globalVersion++;
      this.treeStatus = null;
      this.connectionStatus = 'connected';
    };

    const onBlackboardWrite = (data: unknown) => {
      const d = data as { key: string; value: unknown };
      this.blackboardEntries = { ...this.blackboardEntries, [d.key]: d.value };
      this.blackboardVersions = {
        ...this.blackboardVersions,
        [d.key]: (this.blackboardVersions[d.key] ?? 0) + 1,
      };
      this.globalVersion++;
    };

    const onTreeTick = (data: unknown) => {
      const d = data as { status: string; durationMs: number };
      this.treeStatus = {
        status: d.status,
        durationMs: d.durationMs,
        localTickCount: (this.treeStatus?.localTickCount ?? 0) + 1,
      };
    };

    const onConnectionError = (data: unknown) => {
      const d = data as { readyState: number };
      if (d.readyState === 2) {
        this.connectionStatus = 'disconnected';
      } else {
        this.connectionStatus = 'connecting';
      }
    };

    client.on('snapshot', onSnapshot);
    client.on('blackboard:write', onBlackboardWrite);
    client.on('tree:tick', onTreeTick);
    client.on('connection:error', onConnectionError);

    return () => {
      client.off('snapshot', onSnapshot);
      client.off('blackboard:write', onBlackboardWrite);
      client.off('tree:tick', onTreeTick);
      client.off('connection:error', onConnectionError);
      this.connectionStatus = 'disconnected';
    };
  }
}
