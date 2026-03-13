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

  // Panel widths
  let leftWidth = $state(250);
  let rightWidth = $state(280);

  // Collapse state
  let leftCollapsed = $state(false);
  let rightCollapsed = $state(false);

  // Drag state
  let dragging = $state<'left' | 'right' | null>(null);

  function onMouseDown(panel: 'left' | 'right') {
    return (e: MouseEvent) => {
      dragging = panel;
      e.preventDefault();
    };
  }

  function onMouseMove(e: MouseEvent) {
    if (!dragging) return;
    if (dragging === 'left') {
      leftWidth = Math.max(150, Math.min(400, e.clientX));
    } else {
      rightWidth = Math.max(150, Math.min(450, window.innerWidth - e.clientX));
    }
  }

  function onMouseUp() {
    dragging = null;
  }

  // Responsive: track window width for narrow layout
  let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1200);
  let isNarrow = $derived(windowWidth < 900);
  let activeTab = $state<'events' | 'blackboard'>('events');

  function onWindowResize() {
    windowWidth = window.innerWidth;
  }

  // Reactive grid columns
  let gridColumns = $derived(
    isNarrow
      ? '1fr'
      : `${leftCollapsed ? '0px' : `${leftWidth}px`} 4px 1fr 4px ${rightCollapsed ? '0px' : `${rightWidth}px`}`
  );
</script>

<svelte:window
  onmousemove={onMouseMove}
  onmouseup={onMouseUp}
  onresize={onWindowResize}
/>

<div class="dashboard">
  <Header />
  <main
    class="dash-body"
    class:narrow={isNarrow}
    class:dragging={dragging !== null}
    style:grid-template-columns={gridColumns}
  >
    {#if !isNarrow}
      <div class="panel-wrapper" class:collapsed={leftCollapsed}>
        <TreePanel
          collapsed={leftCollapsed}
          onToggle={() => { leftCollapsed = !leftCollapsed; }}
        />
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="resize-handle" onmousedown={onMouseDown('left')}></div>
      <div class="panel-wrapper center-panel">
        <EventTimeline />
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="resize-handle" onmousedown={onMouseDown('right')}></div>
      <div class="panel-wrapper" class:collapsed={rightCollapsed}>
        <BlackboardPanel
          collapsed={rightCollapsed}
          onToggle={() => { rightCollapsed = !rightCollapsed; }}
        />
      </div>
    {:else}
      <!-- Narrow layout: tree as header bar, tabs for center/right -->
      <div class="narrow-tree-bar">
        <TreePanel collapsed={false} onToggle={() => {}} />
      </div>
      <div class="tab-bar">
        <button class:active={activeTab === 'events'} onclick={() => activeTab = 'events'}>Events</button>
        <button class:active={activeTab === 'blackboard'} onclick={() => activeTab = 'blackboard'}>Blackboard</button>
      </div>
      <div class="narrow-content">
        {#if activeTab === 'events'}
          <EventTimeline />
        {:else}
          <BlackboardPanel collapsed={false} onToggle={() => {}} />
        {/if}
      </div>
    {/if}
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
    flex: 1;
    overflow: hidden;
  }

  /* Wide layout: columns set via inline style */
  .dash-body:not(.narrow) {
    grid-template-rows: 1fr;
  }

  /* Collapsed panel wrappers collapse to zero */
  .panel-wrapper {
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .panel-wrapper.collapsed {
    overflow: hidden;
  }

  /* Center panel fills remaining space */
  .center-panel {
    min-width: 0;
  }

  /* Resize handle */
  .resize-handle {
    width: 4px;
    cursor: col-resize;
    background: transparent;
    transition: background 0.15s;
    flex-shrink: 0;
    z-index: 10;
  }
  .resize-handle:hover,
  .resize-handle:active {
    background: var(--accent);
  }
  /* While dragging, show the active handle highlight */
  .dragging .resize-handle {
    background: var(--accent);
  }

  /* Narrow layout */
  .dash-body.narrow {
    grid-template-columns: 1fr !important;
    grid-template-rows: auto auto 1fr;
    overflow: hidden;
  }
  .narrow-tree-bar {
    max-height: 48px;
    overflow: hidden;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .tab-bar {
    display: flex;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }
  .tab-bar button {
    flex: 1;
    padding: 8px 0;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    cursor: pointer;
    font-family: var(--font-ui);
    transition: color 0.15s, border-color 0.15s;
  }
  .tab-bar button:hover {
    color: var(--text-secondary);
  }
  .tab-bar button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .narrow-content {
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
</style>
