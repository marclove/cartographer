<script lang="ts">
  import type { CartographerClient } from '@cartographer/client';
  import Cartographer from '../provider.svelte';
  import { getConnectionStatus } from '../status.svelte.js';
  import { getTreeStatus } from '../status.svelte.js';

  let { client }: {
    client: CartographerClient;
  } = $props();
</script>

<Cartographer url="http://localhost:3148" {client}>
  {#snippet children()}
    {@const connStatus = getConnectionStatus()}
    {@const treeStatus = getTreeStatus()}
    <div data-testid="conn-status">{connStatus.current}</div>
    <div data-testid="tree-status">{JSON.stringify(treeStatus.current)}</div>
  {/snippet}
</Cartographer>
