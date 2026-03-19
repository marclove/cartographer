<script lang="ts">
  import type { CartographerClient } from '@cartographer/client';
  import Cartographer from '../provider.svelte';
  import { getClient } from '../context.js';
  import { getContext } from 'svelte';
  import { CARTOGRAPHER_STATE_KEY } from '../context.js';
  import type { CartographerState } from '../state.svelte.js';

  let { client, onContext }: {
    client: CartographerClient;
    onContext?: (ctx: { client: CartographerClient; state: CartographerState }) => void;
  } = $props();
</script>

<Cartographer url="http://localhost:3148" {client}>
  {#snippet children()}
    {@const innerClient = getClient()}
    {@const state = getContext<CartographerState>(CARTOGRAPHER_STATE_KEY)}
    {onContext?.({ client: innerClient, state })}
    <div data-testid="child">ready</div>
  {/snippet}
</Cartographer>
