<script lang="ts">
  import type { CartographerClient } from '@cartographer/client';
  import Cartographer from '../provider.svelte';
  import { createCommand, type CommandRef } from '../command.svelte.js';

  let { client, commandName, onCommand }: {
    client: CartographerClient;
    commandName: string;
    onCommand: (command: CommandRef) => void;
  } = $props();
</script>

<Cartographer url="http://localhost:3148" {client}>
  {#snippet children()}
    {@const command = createCommand(commandName)}
    {onCommand(command)}
    <div data-testid="pending">{command.pending}</div>
  {/snippet}
</Cartographer>
