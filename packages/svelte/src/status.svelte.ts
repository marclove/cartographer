import { getContext } from 'svelte';
import { CartographerState } from './state.svelte.js';
import { CARTOGRAPHER_STATE_KEY } from './context.js';
import type { ConnectionStatus, TreeStatusInfo } from './types.js';

export interface ConnectionStatusRef {
  readonly current: ConnectionStatus;
}

export interface TreeStatusRef {
  readonly current: TreeStatusInfo | null;
}

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
