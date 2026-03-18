<script lang="ts">
  import { getBlackboard, getRecentlyUpdatedKeys } from '../lib/stores.svelte.js';

  interface Props {
    collapsed: boolean;
    onToggle: () => void;
  }

  let { collapsed, onToggle }: Props = $props();

  let blackboard = $derived(getBlackboard());
  let recentlyUpdatedKeys = $derived(getRecentlyUpdatedKeys());

  interface BaseEntry {
    key: string;       // display key (without scope prefix)
    fullKey: string;   // full key for lookup
    value: unknown;
    type: string;
  }

  interface GroupedEntry extends BaseEntry {
    updated: boolean;
  }

  interface Group {
    scope: string;
    entries: GroupedEntry[];
  }

  // Structural grouping: only recomputes when blackboard keys/values change
  let groupsBase = $derived.by(() => {
    const groupMap = new Map<string, BaseEntry[]>();

    for (const [fullKey, value] of Object.entries(blackboard)) {
      const colonIdx = fullKey.indexOf(':');
      let scope: string;
      let displayKey: string;
      if (colonIdx > 0) {
        scope = fullKey.slice(0, colonIdx) + ':';
        displayKey = fullKey.slice(colonIdx + 1);
      } else {
        scope = 'root';
        displayKey = fullKey;
      }

      if (!groupMap.has(scope)) groupMap.set(scope, []);
      groupMap.get(scope)!.push({
        key: displayKey,
        fullKey,
        value,
        type: getTypeLabel(value),
      });
    }

    const result: { scope: string; entries: BaseEntry[] }[] = [];
    if (groupMap.has('root')) {
      result.push({ scope: 'root', entries: groupMap.get('root')! });
      groupMap.delete('root');
    }
    for (const [scope, entries] of [...groupMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      result.push({ scope, entries });
    }
    return result;
  });

  // Highlight flags: cheap to recompute on timer-driven recentlyUpdatedKeys changes
  let groups: Group[] = $derived(
    groupsBase.map(g => ({
      ...g,
      entries: g.entries.map(e => ({ ...e, updated: recentlyUpdatedKeys.has(e.fullKey) })),
    }))
  );

  function getTypeLabel(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return 'str';
    if (typeof value === 'number') return 'num';
    if (typeof value === 'boolean') return 'bool';
    if (Array.isArray(value)) return 'arr';
    if (typeof value === 'object') return 'obj';
    return '?';
  }

  function formatValue(value: unknown): string {
    if (typeof value === 'string') return `"${value}"`;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
</script>

<div class="panel">
  <div class="panel-header">
    <div class="panel-title">Blackboard</div>
    <button class="collapse-btn" onclick={onToggle} title={collapsed ? 'Expand panel' : 'Collapse panel'}>
      {collapsed ? '◂' : '▸'}
    </button>
  </div>
  {#if !collapsed}
  <div class="panel-body">
    {#each groups as group}
      <div class="bb-group-title">{group.scope}</div>
      {#each group.entries as entry (entry.fullKey)}
        <div class="bb-entry" class:updated={entry.updated}>
          <span class="bb-key">{entry.key}</span>
          <span class="bb-right">
            <span class="bb-value" title={formatValue(entry.value)}>{formatValue(entry.value)}</span>
            <span class="bb-type">{entry.type}</span>
          </span>
        </div>
      {/each}
    {/each}
    {#if groups.length === 0}
      <div class="empty">Blackboard is empty</div>
    {/if}
  </div>
  {/if}
</div>

<style>
  .bb-group-title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-dim);
    margin-bottom: 8px;
    margin-top: 14px;
  }
  .bb-group-title:first-child { margin-top: 0; }
  .bb-entry {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 5px 8px;
    border-radius: 5px;
    margin-bottom: 2px;
    border: 1px solid transparent;
  }
  .bb-entry:hover { background: var(--bg-hover); }
  .bb-entry.updated {
    background: rgba(34, 211, 153, 0.06);
    border-color: rgba(34, 211, 153, 0.15);
  }
  .bb-key {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .bb-right {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .bb-value {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-secondary);
    text-align: right;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bb-type {
    font-size: 9px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
</style>
