<script lang="ts">
  import { setContext } from 'svelte';
  import { getClient } from '@cartographer/svelte';
  import { DashboardState, DASHBOARD_STATE_KEY } from '../lib/stores.svelte.js';
  import type { Snippet } from 'svelte';

  let { url = '', children }: { url?: string; children: Snippet } = $props();

  const client = getClient();
  const state = new DashboardState();
  setContext(DASHBOARD_STATE_KEY, state);

  $effect(() => {
    const detach = state.wire(client, url);
    return detach;
  });
</script>

{@render children()}
