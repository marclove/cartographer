<script lang="ts">
  import type { CartographerClient } from '@cartographer/client';
  import Cartographer from '../provider.svelte';
  import { onClientEvent } from '../events.svelte.js';

  let { client, eventName, handler }: {
    client: CartographerClient;
    eventName: string;
    handler: (data: unknown) => void;
  } = $props();
</script>

<Cartographer url="http://localhost:3148" {client}>
  {#snippet children()}
    {onClientEvent(eventName, handler)}
    <div data-testid="event-listener">ready</div>
  {/snippet}
</Cartographer>
