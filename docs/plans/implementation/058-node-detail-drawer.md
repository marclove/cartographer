# Task 58: Node Detail Drawer

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the bottom drawer that shows detailed information for the selected node — type-specific details for AgentNodes, composites, and all nodes.

**Depends on:** Task 55 (tree panel provides node selection)

**Visual reference:** `docs/superpowers/specs/dashboard-layout.png` — bottom drawer

---

### Step 1: Extend stores with node detail data

The `/api/nodes/:id` endpoint returns more detail than the tree structure alone. Add a fetch-on-select pattern.

Edit `dashboard/src/lib/stores.svelte.ts` — add near the selected node section:

```ts
import { fetchNode } from './api.js';

let nodeDetail = $state<Record<string, unknown> | null>(null);
export function getNodeDetail() { return nodeDetail; }
```

Then update the existing `selectNode` function to fetch detail on selection:

```ts
export function selectNode(id: string | null) {
  selectedNodeId = selectedNodeId === id ? null : id;
  if (selectedNodeId) {
    fetchNode(selectedNodeId).then((data) => {
      nodeDetail = data;
    }).catch(() => {
      nodeDetail = null;
    });
  } else {
    nodeDetail = null;
  }
}
```

### Step 2: Create NodeDetail component

Create `dashboard/src/components/NodeDetail.svelte`:

```svelte
<script lang="ts">
  import {
    getSelectedNodeId,
    getNodeDetail,
    getNodeStatuses,
    selectNode,
  } from '../lib/stores.svelte.js';

  let selectedNodeId = $derived(getSelectedNodeId());
  let detail = $derived(getNodeDetail());
  let nodeStatuses = $derived(getNodeStatuses());

  let status = $derived(selectedNodeId ? (nodeStatuses.get(selectedNodeId) ?? null) : null);

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
      <button class="close-btn" onclick={() => selectNode(null)}>&#10005;</button>
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
  }
  .tool-list li {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    padding: 1px 0;
  }
</style>
```

### Step 3: Enrich /api/nodes/:id response for AgentNodes

Edit `src/server/api-handlers.ts` — update `handleApiNode` to return richer detail for AgentNodes:

```ts
import { AgentNode } from '../nodes/agent.js';
// ... in handleApiNode:

const base = serializeNodeRef(node);
const detail: Record<string, unknown> = { ...base };

if (node instanceof AgentNode) {
  // AgentNode exposes config — extract what's useful
  const config = (node as any).config;
  if (config) {
    detail.model = config.model;
    detail.tools = config.tools?.map((t: any) => t.name ?? t) ?? [];
    detail.mcpServers = config.mcpServers ?? [];
  }
}

if (node.children.length > 0) {
  detail.children = node.children.map(serializeNodeRef);
}

jsonResponse(res, 200, detail);
```

### Step 4: Wire into App.svelte

Edit `dashboard/src/App.svelte` — import NodeDetail and replace the drawer placeholder:

```svelte
import NodeDetail from './components/NodeDetail.svelte';
<!-- Replace the footer/drawer section with: -->
<NodeDetail />
```

### Step 5: Verify build

Run: `npm run dashboard:build && npm run typecheck`
Expected: Both pass.

### Step 6: Commit

```bash
git add dashboard/src/components/NodeDetail.svelte dashboard/src/lib/stores.svelte.ts dashboard/src/App.svelte src/server/api-handlers.ts
git commit -m "feat(dashboard): add node detail drawer with agent-specific info"
```
