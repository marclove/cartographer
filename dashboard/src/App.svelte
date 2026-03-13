<script lang="ts">
  import { connect, disconnect, getSelectedNodeId } from './lib/stores.svelte.js';
  import { onMount } from 'svelte';
  import Header from './components/Header.svelte';
  import TreePanel from './components/TreePanel.svelte';
  import EventTimeline from './components/EventTimeline.svelte';
  import './styles/theme.css';

  let selectedNodeId = $derived(getSelectedNodeId());

  onMount(() => {
    connect();
    return () => disconnect();
  });
</script>

<div class="dashboard">
  <Header />
  <main class="dash-body">
    <TreePanel />
    <EventTimeline />
    <div class="panel blackboard-panel">
      <div class="panel-header"><div class="panel-title">Blackboard</div></div>
      <div class="panel-body">Blackboard placeholder</div>
    </div>
  </main>
  {#if selectedNodeId}
    <footer class="drawer">
      <div class="panel-header"><div class="panel-title">Node Detail</div></div>
      <div class="panel-body">Detail placeholder</div>
    </footer>
  {/if}
</div>

<style>
  .dashboard {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .dash-body {
    display: grid;
    grid-template-columns: 250px 1fr 280px;
    flex: 1;
    overflow: hidden;
  }
.blackboard-panel { border-right: none; }
  .drawer {
    border-top: 1px solid var(--border);
    background: var(--bg-surface);
    max-height: 200px;
    overflow-y: auto;
  }
</style>
