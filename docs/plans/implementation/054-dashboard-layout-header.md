# Task 54: Dashboard Layout, Theme, and Header

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the three-column layout shell, global theme CSS, and header bar component. This establishes the visual foundation that all panel components slot into.

**Depends on:** Task 53

**Visual reference:** `docs/superpowers/specs/dashboard-layout.png` and `.superpowers/brainstorm/*/dashboard-layout.html`

---

### Step 1: Create global theme CSS

Create `dashboard/src/styles/theme.css`:

Design tokens and base styles matching the approved mockup. Dark navy palette, Inter + JetBrains Mono fonts.

```css
:root {
  /* Background */
  --bg-base: #0a0e17;
  --bg-surface: #0d1220;
  --bg-hover: #141c2b;
  --bg-selected: #161f33;

  /* Borders */
  --border: #1e2a3a;
  --border-selected: #2a3a5c;

  /* Text */
  --text-primary: #e8ecf1;
  --text-secondary: #c8d1dc;
  --text-muted: #8b95a5;
  --text-faint: #5a6577;
  --text-dim: #3d4a5c;

  /* Status */
  --status-success: #34d399;
  --status-failure: #f87171;
  --status-running: #f5a623;
  --status-idle: #2a3344;

  /* Node types */
  --node-sequence-bg: #1e2a4a;
  --node-sequence-fg: #6c8fff;
  --node-selector-bg: #2a1e3a;
  --node-selector-fg: #b07cff;
  --node-action-bg: #1a2e2a;
  --node-action-fg: #34d399;
  --node-condition-bg: #2e2a1a;
  --node-condition-fg: #f5a623;
  --node-agent-bg: #1e1a2e;
  --node-agent-fg: #a78bfa;
  --node-parallel-bg: #1a2a2e;
  --node-parallel-fg: #22d3ee;
  --node-decorator-bg: #2a2020;
  --node-decorator-fg: #f87171;

  /* Event tags */
  --tag-enter-bg: #0f1f2e;
  --tag-enter-fg: #38bdf8;
  --tag-exit-bg: #0f2018;
  --tag-exit-fg: #34d399;
  --tag-exit-fail-bg: #200f0f;
  --tag-exit-fail-fg: #f87171;
  --tag-thinking-bg: #1a1530;
  --tag-thinking-fg: #a78bfa;
  --tag-tool-bg: #1f1a10;
  --tag-tool-fg: #f5a623;
  --tag-text-bg: #101520;
  --tag-text-fg: #8b95a5;
  --tag-bb-bg: #0f1f1f;
  --tag-bb-fg: #22d3ee;
  --tag-response-bg: #0f2018;
  --tag-response-fg: #34d399;

  /* Accent */
  --accent: #6c72ff;

  /* Sizing */
  --header-height: 48px;
  --panel-header-height: 38px;

  /* Fonts */
  --font-ui: 'Inter', -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: var(--bg-base);
  color: var(--text-secondary);
  font-family: var(--font-ui);
  font-size: 13px;
  line-height: 1.5;
}

/* Shared panel styles */
.panel {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  overflow: hidden;
}
.panel:last-child { border-right: none; }

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
  flex-shrink: 0;
  height: var(--panel-header-height);
}

.panel-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--text-faint);
}

.panel-body {
  padding: 12px 16px;
  overflow-y: auto;
  flex: 1;
}
```

### Step 2: Create Header component

Create `dashboard/src/components/Header.svelte`:

```svelte
<script lang="ts">
  import {
    getTreeName,
    getTickCount,
    getLastStatus,
    getLastDurationMs,
    getConnectionState,
  } from '../lib/stores.svelte.js';

  let treeName = $derived(getTreeName());
  let tickCount = $derived(getTickCount());
  let lastStatus = $derived(getLastStatus());
  let lastDurationMs = $derived(getLastDurationMs());
  let connectionState = $derived(getConnectionState());

  let statusClass = $derived(
    lastStatus === 'success' ? 'status-success' :
    lastStatus === 'failure' ? 'status-failure' :
    lastStatus === 'running' ? 'status-running' :
    lastStatus === 'paused' ? 'status-paused' : 'status-idle'
  );

  let statusLabel = $derived(
    lastStatus ? lastStatus.toUpperCase() : 'IDLE'
  );

  let durationStr = $derived(
    lastDurationMs != null ? `${(lastDurationMs / 1000).toFixed(1)}s` : '--'
  );

  let connectionClass = $derived(
    connectionState === 'connected' ? 'connected' :
    connectionState === 'reconnecting' ? 'reconnecting' : 'disconnected'
  );
</script>

<header class="dash-header">
  <div class="header-left">
    <div class="logo"><span class="logo-icon">&#9670;</span> Cartographer</div>
    {#if treeName}
      <div class="tree-name">{treeName}</div>
    {/if}
  </div>
  <div class="header-right">
    <div class="header-stat">Tick <strong>{tickCount}</strong></div>
    <div class="header-stat"><strong>{durationStr}</strong></div>
    <div class="status-badge {statusClass}">
      <div class="status-dot"></div>
      {statusLabel}
    </div>
    <div class="connection-badge {connectionClass}">
      <div class="connection-dot"></div>
      {connectionState === 'connected' ? 'Live' : connectionState === 'reconnecting' ? 'Reconnecting' : 'Disconnected'}
    </div>
  </div>
</header>

<style>
  .dash-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 20px;
    height: var(--header-height);
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
  }
  .header-left, .header-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .header-right { gap: 12px; }
  .logo {
    font-weight: 700;
    font-size: 15px;
    color: var(--text-primary);
    letter-spacing: -0.3px;
  }
  .logo-icon { color: var(--accent); }
  .tree-name {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-muted);
    padding: 3px 10px;
    background: var(--bg-hover);
    border-radius: 6px;
    border: 1px solid var(--border);
  }
  .header-stat {
    font-size: 12px;
    color: var(--text-faint);
  }
  .header-stat strong {
    color: var(--text-muted);
    font-weight: 500;
  }
  .status-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .status-success { background: rgba(52, 211, 153, 0.12); color: var(--status-success); border: 1px solid rgba(52, 211, 153, 0.25); }
  .status-success .status-dot { background: var(--status-success); }
  .status-failure { background: rgba(248, 113, 113, 0.12); color: var(--status-failure); border: 1px solid rgba(248, 113, 113, 0.25); }
  .status-failure .status-dot { background: var(--status-failure); }
  .status-running { background: rgba(245, 166, 35, 0.12); color: var(--status-running); border: 1px solid rgba(245, 166, 35, 0.25); }
  .status-running .status-dot { background: var(--status-running); animation: pulse 2s ease-in-out infinite; }
  .status-paused { background: rgba(108, 114, 255, 0.12); color: var(--accent); border: 1px solid rgba(108, 114, 255, 0.25); }
  .status-paused .status-dot { background: var(--accent); }
  .status-idle { background: rgba(42, 51, 68, 0.3); color: var(--text-faint); border: 1px solid var(--border); }
  .status-idle .status-dot { background: var(--status-idle); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  .connection-badge {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
  }
  .connection-dot { width: 5px; height: 5px; border-radius: 50%; }
  .connected { color: var(--status-success); }
  .connected .connection-dot { background: var(--status-success); }
  .reconnecting { color: var(--status-running); }
  .reconnecting .connection-dot { background: var(--status-running); animation: pulse 1s ease-in-out infinite; }
  .disconnected { color: var(--status-failure); }
  .disconnected .connection-dot { background: var(--status-failure); }
</style>
```

### Step 3: Update App.svelte with three-column layout

Replace the content of `dashboard/src/App.svelte`:

```svelte
<script lang="ts">
  import { connect, disconnect, getSelectedNodeId } from './lib/stores.svelte.js';
  import { onMount } from 'svelte';
  import Header from './components/Header.svelte';
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
    <div class="panel tree-panel">
      <div class="panel-header"><div class="panel-title">Tree</div></div>
      <div class="panel-body">Tree panel placeholder</div>
    </div>
    <div class="panel timeline-panel">
      <div class="panel-header"><div class="panel-title">Events</div></div>
      <div class="panel-body">Timeline placeholder</div>
    </div>
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
  .tree-panel { min-width: 200px; }
  .timeline-panel { border-right: 1px solid var(--border); }
  .blackboard-panel { border-right: none; }
  .drawer {
    border-top: 1px solid var(--border);
    background: var(--bg-surface);
    max-height: 200px;
    overflow-y: auto;
  }
</style>
```

### Step 4: Verify build

Run: `npm run dashboard:build`
Expected: Build succeeds.

### Step 5: Commit

```bash
git add dashboard/src/styles/ dashboard/src/components/Header.svelte dashboard/src/App.svelte
git commit -m "feat(dashboard): add layout shell, theme, and header component"
```
