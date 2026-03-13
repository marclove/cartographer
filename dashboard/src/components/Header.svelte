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
