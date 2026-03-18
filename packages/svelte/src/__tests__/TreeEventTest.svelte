<script lang="ts">
  import type { CartographerClient } from '@cartographer/client';
  import Cartographer from '../provider.svelte';
  import { onTreeEvent } from '../events.svelte.js';

  let { client, eventType, handler }: {
    client: CartographerClient;
    eventType: string;
    handler: (data: unknown) => void;
  } = $props();
</script>

<Cartographer url="http://localhost:3148" {client}>
  {#snippet children()}
    {onTreeEvent(eventType, handler)}
    <div data-testid="event-listener">ready</div>
  {/snippet}
</Cartographer>
