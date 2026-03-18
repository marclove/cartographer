import { getContext } from 'svelte';
import type { CartographerClient } from '@cartographer/client';
import type { CartographerState } from './state.svelte.js';
import { CARTOGRAPHER_CLIENT_KEY, CARTOGRAPHER_STATE_KEY } from './context.js';

export interface BlackboardRef<T> {
  readonly value: T | undefined;
  set(newValue: T): Promise<void>;
}

export interface BlackboardSnapshotRef {
  readonly current: Record<string, unknown>;
}

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
