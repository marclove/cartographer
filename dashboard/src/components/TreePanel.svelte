<script lang="ts">
  import TreeNode from './TreeNode.svelte';
  import { getTreeRoot } from '../lib/stores.svelte.js';

  interface Props {
    collapsed: boolean;
    onToggle: () => void;
  }

  let { collapsed, onToggle }: Props = $props();

  let treeRoot = $derived(getTreeRoot());
</script>

<div class="panel">
  <div class="panel-header">
    <div class="panel-title">Tree</div>
    <button class="collapse-btn" onclick={onToggle} title={collapsed ? 'Expand panel' : 'Collapse panel'}>
      {collapsed ? '▸' : '◂'}
    </button>
  </div>
  {#if !collapsed}
    <div class="panel-body">
      {#if treeRoot}
        <TreeNode node={treeRoot} />
      {:else}
        <div class="empty">Waiting for tree data...</div>
      {/if}
    </div>
  {/if}
</div>

<style>
</style>
