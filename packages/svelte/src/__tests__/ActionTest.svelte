<script lang="ts">
  import type { CartographerClient } from '@cartographer/client';
  import Cartographer from '../provider.svelte';
  import { createAction, type ActionRef } from '../action.svelte.js';

  let { client, actionName, onAction }: {
    client: CartographerClient;
    actionName: string;
    onAction: (action: ActionRef) => void;
  } = $props();
</script>

<Cartographer url="http://localhost:3148" {client}>
  {#snippet children()}
    {@const action = createAction(actionName)}
    {onAction(action)}
    <div data-testid="pending">{action.pending}</div>
  {/snippet}
</Cartographer>
