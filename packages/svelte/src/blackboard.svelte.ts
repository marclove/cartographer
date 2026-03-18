import { getContext } from 'svelte';
import type { CartographerClient } from '@cartographer/client';
import type { CartographerState } from './state.svelte.js';
import { CARTOGRAPHER_CLIENT_KEY, CARTOGRAPHER_STATE_KEY } from './context.js';

/**
 * Reactive accessor for a single blackboard key, returned by {@link getBlackboard}.
 *
 * @typeParam T - The expected type of the blackboard value.
 */
export interface BlackboardRef<T> {
  /**
   * The current value for the tracked key, or `undefined` if the key has not
   * been written. This getter reads from `$state` internally, so accessing it
   * in a template or `$derived` expression registers a reactive dependency.
   */
  readonly value: T | undefined;

  /**
   * Writes a new value for the key via an HTTP request to the server.
   *
   * This is *not* an optimistic update — `value` will remain unchanged until
   * the server echoes the write back through the SSE `blackboard:write` event.
   *
   * @param newValue - The value to persist for this key.
   */
  set(newValue: T): Promise<void>;
}

/**
 * Reactive accessor for the entire blackboard, returned by
 * {@link getBlackboardSnapshot}.
 */
export interface BlackboardSnapshotRef {
  /**
   * The full blackboard as a key-value record. This getter reads from `$state`
   * internally and updates whenever *any* key changes or a full snapshot is
   * received. Prefer {@link getBlackboard} for targeted subscriptions to avoid
   * re-rendering on unrelated key changes.
   */
  readonly current: Record<string, unknown>;
}

/**
 * Creates a fine-grained reactive accessor for a single blackboard key.
 *
 * Must be called during component initialization inside a `<Cartographer>`
 * provider (same rules as Svelte's `getContext`).
 *
 * @typeParam T - The expected type of the blackboard value.
 * @param key - The blackboard key to track.
 * @returns A {@link BlackboardRef} whose `value` getter is reactive.
 * @throws If called outside a `<Cartographer>` provider.
 */
export function getBlackboard<T = unknown>(key: string): BlackboardRef<T> {
  const client = getContext<CartographerClient>(CARTOGRAPHER_CLIENT_KEY);
  const state = getContext<CartographerState>(CARTOGRAPHER_STATE_KEY);
  if (!client || !state) {
    throw new Error('Cartographer functions must be used within a <Cartographer> provider');
  }

  return {
    get value(): T | undefined {
      return state.blackboardEntries[key] as T | undefined;
    },
    async set(newValue: T): Promise<void> {
      await client.write(key, newValue);
    },
  };
}

/**
 * Creates a reactive accessor for the entire blackboard object.
 *
 * The returned `current` getter updates on every key change and on full
 * snapshot events. Prefer {@link getBlackboard} when you only need a single
 * key, to avoid unnecessary re-renders.
 *
 * Must be called during component initialization inside a `<Cartographer>`
 * provider (same rules as Svelte's `getContext`).
 *
 * @returns A {@link BlackboardSnapshotRef} whose `current` getter is reactive.
 * @throws If called outside a `<Cartographer>` provider.
 */
export function getBlackboardSnapshot(): BlackboardSnapshotRef {
  const state = getContext<CartographerState>(CARTOGRAPHER_STATE_KEY);
  if (!state) {
    throw new Error('Cartographer functions must be used within a <Cartographer> provider');
  }

  return {
    get current(): Record<string, unknown> {
      return state.blackboardEntries;
    },
  };
}
