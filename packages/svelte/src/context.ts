import { getContext } from 'svelte';
import type { CartographerClient } from '@cartographer/client';

export const CARTOGRAPHER_CLIENT_KEY = Symbol('cartographer-client');
export const CARTOGRAPHER_STATE_KEY = Symbol('cartographer-state');

export function getClient(): CartographerClient {
  const client = getContext<CartographerClient | undefined>(CARTOGRAPHER_CLIENT_KEY);
  if (!client) {
    throw new Error('Cartographer functions must be used within a <Cartographer> provider');
  }
  return client;
}
