<script lang="ts">
  import TreeNode from './TreeNode.svelte';
  import { getTreeRoot } from '../lib/stores.svelte.js';

  let treeRoot = $derived(getTreeRoot());
</script>

<div class="panel">
  <div class="panel-header"><div class="panel-title">Tree</div></div>
  <div class="panel-body">
    {#if treeRoot}
      <TreeNode node={treeRoot} />
    {:else}
      <div class="empty">Waiting for tree data...</div>
    {/if}
  </div>
</div>

<style>
  .empty {
    color: var(--text-faint);
    font-size: 12px;
    padding: 8px;
  }
</style>
