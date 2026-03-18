import { onDestroy } from 'svelte';
import { getClient } from './context.js';

export function onClientEvent(name: string, handler: (data: unknown) => void): void {
  const client = getClient();

  let currentHandler = handler;

  const listener = (data: unknown) => currentHandler(data);
  client.on(name, listener);

  onDestroy(() => {
    client.off(name, listener);
  });
}

export function onTreeEvent(type: string, handler: (data: unknown) => void): void {
  const client = getClient();

  let currentHandler = handler;

  const listener = (data: unknown) => currentHandler(data);
  client.on(type, listener);

  onDestroy(() => {
    client.off(type, listener);
  });
}
