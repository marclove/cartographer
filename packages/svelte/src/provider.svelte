<!--
  @component
  Manages the lifecycle of a {@link CartographerClient} and provides it — along
  with a reactive {@link CartographerState} — to all descendant components via
  Svelte context.

  On mount the provider opens the SSE connection; on destroy it disconnects and
  detaches all event listeners. All other `@cartographer/svelte` functions
  (`getBlackboard`, `createAction`, etc.) must be called inside this provider.

  @example
  ```svelte
  <Cartographer url="http://localhost:3148">
    <App />
  </Cartographer>
  ```

  @param url - Base URL of the Cartographer server. A client is created
               automatically via `createCartographerClient(url)`.
  @param client - Bring-your-own client instance. When provided, `url` is
                  ignored. Useful for testing or custom client configuration.
  @param children - Svelte 5 snippet rendered as the provider's child content.
-->
<script lang="ts">
  import { setContext, onMount, onDestroy, untrack } from 'svelte';
  import { createCartographerClient, type CartographerClient } from '@cartographer/client';
  import { CartographerState } from './state.svelte.js';
  import { CARTOGRAPHER_CLIENT_KEY, CARTOGRAPHER_STATE_KEY } from './context.js';
  import type { Snippet } from 'svelte';

  let { url, client: clientProp, children }: {
    url?: string;
    client?: CartographerClient;
    children: Snippet;
  } = $props();

  const client = untrack(() => clientProp ?? createCartographerClient(url!));
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
