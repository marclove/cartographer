<script lang="ts">
  import type { CartographerClient } from '@cartographer/client';
  import Cartographer from '../provider.svelte';
  import { getBlackboard, getBlackboardSnapshot } from '../blackboard.svelte.js';

  let { client, bbKey, onResult }: {
    client: CartographerClient;
    bbKey: string;
    onResult?: (result: { value: unknown; snapshot: Record<string, unknown>; set: (v: unknown) => Promise<void> }) => void;
  } = $props();
</script>

<Cartographer url="http://localhost:3148" {client}>
  {#snippet children()}
    {@const bb = getBlackboard(bbKey)}
    {@const snap = getBlackboardSnapshot()}
    {onResult?.({ value: bb.value, snapshot: snap.current, set: bb.set })}
    <div data-testid="bb-value">{JSON.stringify(bb.value)}</div>
    <div data-testid="bb-snapshot">{JSON.stringify(snap.current)}</div>
  {/snippet}
</Cartographer>
