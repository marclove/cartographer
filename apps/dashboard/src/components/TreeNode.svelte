<script lang="ts">
  import type { TreeNode as TreeNodeType } from '../lib/types.js';
  import { getDashboardState } from '../lib/stores.svelte.js';
  import TreeNode from './TreeNode.svelte';

  let { node, depth = 0 }: { node: TreeNodeType; depth?: number } = $props();

  const dashState = getDashboardState();

  let status = $derived(dashState.nodeStatuses.get(node.id) ?? null);
  let isSelected = $derived(dashState.selectedNodeId === node.id);

  const TYPE_LABELS: Record<string, string> = {
    sequence: 'S',
    selector: 'F',
    parallel: 'P',
    action: 'A',
    condition: '?',
    agent: 'A',
    decorator: 'D',
  };

  let typeLabel = $derived(TYPE_LABELS[node.type] ?? '?');

  let statusClass = $derived(
    status === 'success' ? 'st-success' :
    status === 'failure' ? 'st-failure' :
    status === 'running' ? 'st-running' : 'st-idle'
  );
</script>

<button
  class="tree-node"
  class:selected={isSelected}
  style:padding-left="{16 + depth * 20}px"
  onclick={() => dashState.selectNode(node.id)}
>
  <span class="node-icon type-{node.type}">{typeLabel}</span>
  <span class="node-name">{node.name}</span>
  <span class="node-status {statusClass}"></span>
</button>

{#each node.children as child}
  <TreeNode node={child} depth={depth + 1} />
{/each}

<style>
  .tree-node {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border-radius: 6px;
    cursor: pointer;
    margin-bottom: 1px;
    width: 100%;
    border: 1px solid transparent;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
  }
  .tree-node:hover { background: var(--bg-hover); }
  .tree-node.selected {
    background: var(--bg-selected);
    border-color: var(--border-selected);
  }
  .node-icon {
    width: 16px;
    height: 16px;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .type-sequence { background: var(--node-sequence-bg); color: var(--node-sequence-fg); }
  .type-selector { background: var(--node-selector-bg); color: var(--node-selector-fg); }
  .type-parallel { background: var(--node-parallel-bg); color: var(--node-parallel-fg); }
  .type-action { background: var(--node-action-bg); color: var(--node-action-fg); }
  .type-condition { background: var(--node-condition-bg); color: var(--node-condition-fg); }
  .type-agent { background: var(--node-agent-bg); color: var(--node-agent-fg); }
  .type-decorator { background: var(--node-decorator-bg); color: var(--node-decorator-fg); }
  .node-name {
    font-size: 12.5px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .node-status {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    margin-left: auto;
    flex-shrink: 0;
  }
  .st-success { background: var(--status-success); }
  .st-failure { background: var(--status-failure); }
  .st-running { background: var(--status-running); }
  .st-idle { background: var(--status-idle); }
</style>
