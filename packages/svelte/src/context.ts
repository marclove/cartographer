import { getContext } from 'svelte';
import type { CartographerClient } from '@cartographer/client';

/** Svelte context key for the {@link CartographerClient} instance. */
export const CARTOGRAPHER_CLIENT_KEY = Symbol('cartographer-client');

/** Svelte context key for the internal reactive `CartographerState` used by provider components. */
export const CARTOGRAPHER_STATE_KEY = Symbol('cartographer-state');

/**
 * Returns the {@link CartographerClient} from Svelte context.
 *
 * Use this as an escape hatch when the reactive wrappers don't cover the
 * operation you need — for example, interrupting a tree, resuming execution,
 * or issuing ad-hoc status queries.
 *
 * Must be called during component initialization (i.e., at the top level of a
 * component's `<script>` block), and only inside a `<Cartographer>` provider.
 *
 * @throws {Error} If no `<Cartographer>` provider exists in the component's ancestor tree.
 * @returns The `CartographerClient` instance provided by the nearest `<Cartographer>` ancestor.
 */
export function getClient(): CartographerClient {
  const client = getContext<CartographerClient | undefined>(CARTOGRAPHER_CLIENT_KEY);
  if (!client) {
    throw new Error('Cartographer functions must be used within a <Cartographer> provider');
  }
  return client;
}
