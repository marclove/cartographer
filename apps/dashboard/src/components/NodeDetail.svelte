<script lang="ts">
  import { getDashboardState } from '../lib/stores.svelte.js';

  const dashState = getDashboardState();

  let selectedNodeId = $derived(dashState.selectedNodeId);
  let detail = $derived(dashState.nodeDetail);

  let status = $derived(selectedNodeId ? (dashState.nodeStatuses.get(selectedNodeId) ?? null) : null);

  let statusClass = $derived(
    status === 'success' ? 'val-success' :
    status === 'failure' ? 'val-failure' :
    status === 'running' ? 'val-running' : 'val-idle'
  );
</script>

{#if selectedNodeId && detail}
  <div class="drawer">
    <div class="drawer-header">
      <div class="drawer-title">
        <span class="panel-title">Node Detail</span>
        <span class="drawer-node-name">{detail.name ?? selectedNodeId}</span>
      </div>
      <button class="close-btn" onclick={() => dashState.selectNode(null)}>&#10005;</button>
    </div>
    <div class="drawer-body">
      <div class="detail-group">
        <div class="detail-label">Type</div>
        <div class="detail-value">{detail.type ?? 'unknown'}</div>
      </div>

      <div class="detail-group">
        <div class="detail-label">Status</div>
        <div class="detail-value {statusClass}">{status ? status.toUpperCase() : 'IDLE'}</div>
      </div>

      {#if detail.model}
        <div class="detail-group">
          <div class="detail-label">Model</div>
          <div class="detail-value mono">{detail.model}</div>
        </div>
      {/if}

      {#if detail.tools && Array.isArray(detail.tools)}
        <div class="detail-group">
          <div class="detail-label">Tools</div>
          <ul class="tool-list">
            {#each detail.tools as tool}
              <li>{typeof tool === 'string' ? tool : (tool as any).name ?? JSON.stringify(tool)}</li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if detail.mcpServers && Array.isArray(detail.mcpServers)}
        <div class="detail-group">
          <div class="detail-label">MCP Servers</div>
          <ul class="tool-list">
            {#each detail.mcpServers as server}
              <li>{typeof server === 'string' ? server : JSON.stringify(server)}</li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if detail.children && Array.isArray(detail.children)}
        <div class="detail-group">
          <div class="detail-label">Children</div>
          <div class="detail-value mono">{(detail.children as any[]).length} nodes</div>
        </div>
      {/if}

      {#if detail.strategy}
        <div class="detail-group">
          <div class="detail-label">Strategy</div>
          <div class="detail-value mono">{detail.strategy}</div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .drawer {
    border-top: 1px solid var(--border);
    background: var(--bg-surface);
  }
  .drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 20px;
    border-bottom: 1px solid var(--border);
  }
  .drawer-title {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .drawer-node-name {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--node-agent-fg);
    font-weight: 500;
  }
  .close-btn {
    background: none;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    font-size: 14px;
    padding: 4px 8px;
    border-radius: 4px;
  }
  .close-btn:hover { background: var(--bg-hover); color: var(--text-muted); }
  .drawer-body {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 20px;
    padding: 14px 20px;
  }
  .detail-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-dim);
    margin-bottom: 5px;
  }
  .detail-value {
    font-size: 12px;
    color: var(--text-secondary);
  }
  .detail-value.mono {
    font-family: var(--font-mono);
  }
  .val-success { color: var(--status-success); }
  .val-failure { color: var(--status-failure); }
  .val-running { color: var(--status-running); }
  .val-idle { color: var(--text-faint); }
  .tool-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .tool-list li {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    padding: 1px 0;
  }
</style>
