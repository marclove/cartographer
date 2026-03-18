import { getContext } from 'svelte';
import { CartographerState } from './state.svelte.js';
import { CARTOGRAPHER_STATE_KEY } from './context.js';
import type { ConnectionStatus, TreeStatusInfo } from './types.js';

/**
 * Reactive accessor for SSE connection state, returned by
 * {@link getConnectionStatus}.
 */
export interface ConnectionStatusRef {
  /**
   * The current SSE connection status. This getter reads from `$state`
   * internally, so accessing it in a template or `$derived` expression
   * registers a reactive dependency.
   */
  readonly current: ConnectionStatus;
}

/**
 * Reactive accessor for tree tick status, returned by {@link getTreeStatus}.
 */
export interface TreeStatusRef {
  /**
   * The most recent tree tick status, or `null` before the first `tree:tick`
   * event arrives. Resets to `null` on snapshot (e.g., after reconnect).
   */
  readonly current: TreeStatusInfo | null;
}

/**
 * Creates a reactive accessor for the SSE connection state.
 *
 * Must be called during component initialization inside a `<Cartographer>`
 * provider (same rules as Svelte's `getContext`).
 *
 * @returns A {@link ConnectionStatusRef} whose `current` getter is reactive.
 * @throws If called outside a `<Cartographer>` provider.
 */
export function getConnectionStatus(): ConnectionStatusRef {
  const state = getContext<CartographerState>(CARTOGRAPHER_STATE_KEY);
  if (!state) {
    throw new Error('Cartographer functions must be used within a <Cartographer> provider');
  }

  return {
    get current(): ConnectionStatus {
      return state.connectionStatus;
    },
  };
}

/**
 * Creates a reactive accessor for tree tick status.
 *
 * The returned `current` value is `null` until the first `tree:tick` SSE event
 * arrives, and resets to `null` on snapshot (e.g., after reconnect).
 *
 * Must be called during component initialization inside a `<Cartographer>`
 * provider (same rules as Svelte's `getContext`).
 *
 * @returns A {@link TreeStatusRef} whose `current` getter is reactive.
 * @throws If called outside a `<Cartographer>` provider.
 */
export function getTreeStatus(): TreeStatusRef {
  const state = getContext<CartographerState>(CARTOGRAPHER_STATE_KEY);
  if (!state) {
    throw new Error('Cartographer functions must be used within a <Cartographer> provider');
  }

  return {
    get current(): TreeStatusInfo | null {
      return state.treeStatus;
    },
  };
}
