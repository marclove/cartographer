<script lang="ts">
  import EventTag from './EventTag.svelte';
  import {
    getEvents,
    getActiveFilters,
    toggleFilter,
    getSelectedNodeId,
  } from '../lib/stores.svelte.js';
  import { formatTimestamp, formatEventSummary, formatEventDetail } from '../lib/format.js';

  let events = $derived(getEvents());
  let activeFilters = $derived(getActiveFilters());
  let selectedNodeId = $derived(getSelectedNodeId());

  const FILTER_OPTIONS = ['nodes', 'agent', 'blackboard', 'strategy'];

  let filteredEvents = $derived(
    events.filter((e) => {
      if (!activeFilters.has(e.category)) return false;
      // If a node is selected, only show events related to that node
      if (selectedNodeId) {
        const nodeId = (e.data as any)?.node?.id ?? (e.data as any)?.nodeId ?? (e.data as any)?.compositeId;
        if (nodeId && nodeId !== selectedNodeId) return false;
      }
      return true;
    })
  );

  let container: HTMLDivElement;

  // Track which event is expanded
  let expandedEventId = $state<number | null>(null);

  function toggleExpand(id: number) {
    expandedEventId = expandedEventId === id ? null : id;
  }

  // Auto-scroll to bottom when new events arrive, but only if the user
  // hasn't scrolled up to read older events
  $effect(() => {
    filteredEvents.length;
    if (container) {
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distFromBottom < 60) {
        requestAnimationFrame(() => {
          container.scrollTop = container.scrollHeight;
        });
      }
    }
  });
</script>

<div class="panel">
  <div class="filter-bar">
    {#each FILTER_OPTIONS as filter}
      <button
        class="filter-chip"
        class:active={activeFilters.has(filter)}
        onclick={() => toggleFilter(filter)}
      >
        {filter}
      </button>
    {/each}
  </div>
  <div class="panel-body" bind:this={container}>
    {#each filteredEvents as event (event.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="event-row"
        class:expanded={expandedEventId === event.id}
        onclick={() => toggleExpand(event.id)}
      >
        <div class="event-ts">{formatTimestamp(event.timestamp)}</div>
        <div class="event-tag-col"><EventTag event={event.event} /></div>
        <div class="event-content">
          <div class="event-summary">{formatEventSummary(event)}</div>
          {#if expandedEventId === event.id}
            <pre class="event-detail">{formatEventDetail(event)}</pre>
          {/if}
        </div>
      </div>
    {/each}
    {#if filteredEvents.length === 0}
      <div class="empty">No events yet. Waiting for tree execution...</div>
    {/if}
  </div>
</div>

<style>
  .filter-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 16px;
    height: var(--panel-header-height);
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }
  .filter-chip {
    padding: 3px 10px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 500;
    border: 1px solid var(--border);
    color: var(--text-faint);
    cursor: pointer;
    background: none;
    font-family: inherit;
  }
  .filter-chip.active {
    border-color: var(--border-selected);
    color: var(--text-muted);
    background: var(--bg-hover);
  }
  .event-row {
    display: grid;
    grid-template-columns: 68px 120px 1fr;
    gap: 10px;
    padding: 7px 0;
    border-bottom: 1px solid #111927;
    align-items: start;
    font-size: 12.5px;
    cursor: pointer;
  }
  .event-row:hover {
    background: var(--bg-hover);
  }
  .event-row.expanded {
    background: var(--bg-hover);
  }
  .event-ts {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-dim);
  }
  .event-content {
    color: var(--text-muted);
    min-width: 0;
  }
  .event-summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .event-detail {
    margin: 8px 0 4px;
    padding: 8px 10px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 300px;
    overflow-y: auto;
  }
</style>
