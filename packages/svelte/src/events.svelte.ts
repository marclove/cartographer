import { onDestroy } from 'svelte';
import { getClient } from './context.js';

/**
 * Subscribes to a named event emitted by an `NotifyNode` on the server.
 *
 * Events are delivered over the `client:event` SSE channel. The underlying
 * client SDK dispatches by event name, so no additional filtering is needed.
 *
 * The handler is captured once at initialization time. In Svelte 5 the
 * `<script>` block runs only once, so passing a different callback after
 * mount has no effect. Close over reactive state inside the handler if
 * dynamic behavior is needed.
 *
 * Cleans up automatically on component destroy. Must be called during
 * component initialization inside a `<Cartographer>` provider.
 *
 * @param name - The event name to listen for (must match the name used by the
 *   server-side `NotifyNode`).
 * @param handler - Callback invoked with the event payload each time the
 *   named event arrives. Captured at initialization; not updated on re-render.
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
 * The handler is captured once at initialization time. In Svelte 5 the
 * `<script>` block runs only once, so passing a different callback after
 * mount has no effect. Close over reactive state inside the handler if
 * dynamic behavior is needed.
 *
 * Cleans up automatically on component destroy. Must be called during
 * component initialization inside a `<Cartographer>` provider.
 *
 * @param type - The SSE event type to listen for.
 * @param handler - Callback invoked with the event payload each time an
 *   event of the given type arrives. Captured at initialization; not updated on re-render.
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
