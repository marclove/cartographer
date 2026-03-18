import { onDestroy } from 'svelte';
import { getClient } from './context.js';

/**
 * Subscribes to a named event emitted by an `EmitToClientNode` on the server.
 *
 * Events are delivered over the `client:event` SSE channel. The underlying
 * client SDK dispatches by event name, so no additional filtering is needed.
 *
 * The handler reference is stored in a mutable variable, allowing the
 * callback closure to change between renders without re-registering the
 * subscription.
 *
 * Cleans up automatically on component destroy. Must be called during
 * component initialization inside a `<Cartographer>` provider.
 *
 * @param name - The event name to listen for (must match the name used by the
 *   server-side `EmitToClientNode`).
 * @param handler - Callback invoked with the event payload each time the
 *   named event arrives.
 */
export function onClientEvent(name: string, handler: (data: unknown) => void): void {
  const client = getClient();

  let currentHandler = handler;

  const listener = (data: unknown) => currentHandler(data);
  client.on(name, listener);

  onDestroy(() => {
    client.off(name, listener);
  });
}

/**
 * Subscribes to a raw SSE event by type (e.g. `node:enter`, `node:exit`,
 * `tree:tick`).
 *
 * Useful for reacting to low-level tree lifecycle events that are not
 * addressed by higher-level helpers like {@link onClientEvent}.
 *
 * The handler reference is stored in a mutable variable, allowing the
 * callback closure to change between renders without re-registering the
 * subscription.
 *
 * Cleans up automatically on component destroy. Must be called during
 * component initialization inside a `<Cartographer>` provider.
 *
 * @param type - The SSE event type to listen for.
 * @param handler - Callback invoked with the event payload each time an
 *   event of the given type arrives.
 */
export function onTreeEvent(type: string, handler: (data: unknown) => void): void {
  const client = getClient();

  let currentHandler = handler;

  const listener = (data: unknown) => currentHandler(data);
  client.on(type, listener);

  onDestroy(() => {
    client.off(type, listener);
  });
}
