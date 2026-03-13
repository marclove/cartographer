# Task 57: Blackboard Panel Component

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the blackboard panel — a live key-value display grouped by namespace scope, with type indicators and update highlighting.

**Depends on:** Task 54

**Visual reference:** `docs/superpowers/specs/dashboard-layout.png` — right column

---

### Step 1: Create BlackboardPanel component

Create `dashboard/src/components/BlackboardPanel.svelte`:

```svelte
<script lang="ts">
  import { getBlackboard, getRecentlyUpdatedKeys } from '../lib/stores.svelte.js';

  let blackboard = $derived(getBlackboard());
  let recentlyUpdatedKeys = $derived(getRecentlyUpdatedKeys());

  interface GroupedEntry {
    key: string;       // display key (without scope prefix)
    fullKey: string;   // full key for lookup
    value: unknown;
    type: string;
    updated: boolean;
  }

  interface Group {
    scope: string;
    entries: GroupedEntry[];
  }

  let groups = $derived.by(() => {
    const groupMap = new Map<string, GroupedEntry[]>();

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
        updated: recentlyUpdatedKeys.has(fullKey),
      });
    }

    const result: Group[] = [];
    // Root group first
    if (groupMap.has('root')) {
      result.push({ scope: 'root', entries: groupMap.get('root')! });
      groupMap.delete('root');
    }
    // Then scoped groups alphabetically
    for (const [scope, entries] of [...groupMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      result.push({ scope, entries });
    }
    return result;
  });

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
  <div class="panel-header"><div class="panel-title">Blackboard</div></div>
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
  .empty {
    color: var(--text-faint);
    font-size: 12px;
    padding: 20px 0;
    text-align: center;
  }
</style>
```

### Step 2: Wire into App.svelte

Edit `dashboard/src/App.svelte` — import and replace the blackboard placeholder:

```svelte
import BlackboardPanel from './components/BlackboardPanel.svelte';
<!-- Replace blackboard-panel div with: -->
<BlackboardPanel />
```

### Step 3: Verify build

Run: `npm run dashboard:build`
Expected: Build succeeds.

### Step 4: Commit

```bash
git add dashboard/src/components/BlackboardPanel.svelte dashboard/src/App.svelte
git commit -m "feat(dashboard): add blackboard panel with scope grouping and update highlighting"
```
