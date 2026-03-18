<script lang="ts">
  import { setContext, onMount, onDestroy } from 'svelte';
  import { createCartographerClient, type CartographerClient } from '@cartographer/client';
  import { CartographerState } from './state.svelte.js';
  import { CARTOGRAPHER_CLIENT_KEY, CARTOGRAPHER_STATE_KEY } from './context.js';
  import type { Snippet } from 'svelte';

  let { url, client: clientProp, children }: {
    url?: string;
    client?: CartographerClient;
    children: Snippet;
  } = $props();

  const client = clientProp ?? createCartographerClient(url!);
  const state = new CartographerState();

  setContext(CARTOGRAPHER_CLIENT_KEY, client);
  setContext(CARTOGRAPHER_STATE_KEY, state);

  const detach = state.attach(client);

  onMount(() => {
    client.connect();
  });

  onDestroy(() => {
    client.disconnect();
    detach();
  });
</script>

{@render children()}
