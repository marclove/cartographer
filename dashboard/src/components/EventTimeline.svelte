<script lang="ts">
  import EventTag from './EventTag.svelte';
  import {
    getEvents,
    getActiveFilters,
    toggleFilter,
    getEventCategory,
    getSelectedNodeId,
  } from '../lib/stores.svelte.js';
  import type { TimelineEvent } from '../lib/stores.svelte.js';

  let events = $derived(getEvents());
  let activeFilters = $derived(getActiveFilters());
  let selectedNodeId = $derived(getSelectedNodeId());

  const FILTER_OPTIONS = ['nodes', 'agent', 'blackboard', 'strategy'];

  let filteredEvents = $derived(
    events.filter((e) => {
      const category = getEventCategory(e.event);
      if (!activeFilters.has(category)) return false;
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

  // Auto-scroll to bottom when new events arrive
  $effect(() => {
    // Access filteredEvents.length to trigger on change
    filteredEvents.length;
    if (container) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
  });

  function formatTimestamp(ts: number): string {
    if (!ts) return '--:--';
    const d = new Date(ts);
    const min = String(d.getMinutes()).padStart(2, '0');
    const sec = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${min}:${sec}.${ms}`;
  }

  function formatEventSummary(e: TimelineEvent): string {
    const d = e.data as Record<string, unknown>;
    switch (e.event) {
      case 'node:enter':
        return (d['node'] as any)?.name ?? '';
      case 'node:exit': {
        const name = (d['node'] as any)?.name ?? '';
        const status = (d['status'] as string)?.toUpperCase() ?? '';
        const ms = d['durationMs'] != null ? `${d['durationMs']}ms` : '';
        return `${name} — ${status} ${ms}`;
      }
      case 'node:error':
        return `${(d['node'] as any)?.name ?? ''}: ${d['error'] ?? 'unknown error'}`;
      case 'agent:thinking':
        return `${d['text'] ?? ''}`;
      case 'agent:text':
        return `${d['text'] ?? ''}`;
      case 'agent:tool_use':
        return `${d['tool'] ?? ''}`;
      case 'agent:response':
        return d['cost'] != null ? `cost: $${Number(d['cost']).toFixed(4)}` : 'completed';
      case 'agent:init': {
        const tools = (d['tools'] as unknown[])?.length ?? 0;
        const mcps = (d['mcpServers'] as unknown[])?.length ?? 0;
        return `model: ${d['model'] ?? ''}, ${tools} tools, ${mcps} MCP servers`;
      }
      case 'agent:status':
        return `${d['status'] ?? ''}`;
      case 'agent:prompt':
        return `${d['prompt'] ?? ''}`;
      case 'agent:tool_progress': {
        const elapsed = d['elapsedSeconds'] != null ? `${d['elapsedSeconds']}s` : '';
        return `${d['toolName'] ?? ''} ${elapsed}`;
      }
      case 'agent:rate_limit':
        return JSON.stringify(d['info'] ?? '');
      case 'agent:error':
        return `${d['subtype'] ?? ''}: ${(d['errors'] as string[])?.join(', ') ?? ''}`;
      case 'blackboard:write':
        return `${d['key']} = ${JSON.stringify(d['value'])}`;
      case 'tree:tick': {
        const s = (d['status'] as string)?.toUpperCase() ?? '';
        return `${d['tree'] ?? ''} — ${s} (${d['durationMs']}ms)`;
      }
      case 'tree:reset':
      case 'tree:abort':
        return `${d['tree'] ?? ''}`;
      case 'strategy:decision':
        return `${d['strategy'] ?? ''}`;
      default:
        return JSON.stringify(d);
    }
  }

  function formatEventDetail(e: TimelineEvent): string {
    return JSON.stringify(e.data, null, 2);
  }
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
    gap: 6px;
    padding: 10px 16px;
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
  .empty {
    color: var(--text-faint);
    font-size: 12px;
    padding: 20px 0;
    text-align: center;
  }
</style>
