<script lang="ts">
  import { connect, disconnect } from './lib/stores.svelte.js';
  import { onMount } from 'svelte';
  import Header from './components/Header.svelte';
  import TreePanel from './components/TreePanel.svelte';
  import EventTimeline from './components/EventTimeline.svelte';
  import BlackboardPanel from './components/BlackboardPanel.svelte';
  import NodeDetail from './components/NodeDetail.svelte';
  import './styles/theme.css';

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
    <BlackboardPanel />
  </main>
  <NodeDetail />
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
</style>
