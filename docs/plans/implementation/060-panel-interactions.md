# Task 60: Panel Resize, Collapse, and Responsive Layout

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add interactive panel behaviors: draggable resize handles between columns, collapse toggles on panel headers, responsive breakpoints that reorganize the layout on smaller screens.

**Depends on:** Tasks 54–58 (all panels must exist before adding interactions)

---

### Step 1: Add resize handles

Edit `dashboard/src/App.svelte` — replace the fixed `grid-template-columns` with a reactive style bound to draggable widths.

Add state for panel widths:

```svelte
<script lang="ts">
  let leftWidth = $state(250);
  let rightWidth = $state(300);
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
</script>

<svelte:window on:mousemove={onMouseMove} on:mouseup={onMouseUp} />
```

Update the grid template to use reactive widths:

```svelte
<main class="dash-body" style:grid-template-columns="{leftWidth}px 1fr {rightCollapsed ? '0px' : `${rightWidth}px`}">
```

Add resize handle elements between panels:

```svelte
<div class="resize-handle" onmousedown={onMouseDown('left')}></div>
<!-- timeline panel -->
<div class="resize-handle" onmousedown={onMouseDown('right')}></div>
```

Style the handles:

```css
.resize-handle {
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.15s;
}
.resize-handle:hover, .resize-handle:active {
  background: var(--accent);
}
```

### Step 2: Add collapse toggles

Add collapse state for each side panel:

```svelte
<script lang="ts">
  let leftCollapsed = $state(false);
  let rightCollapsed = $state(false);
</script>
```

Add toggle buttons in each panel header. When collapsed, the panel gets `width: 0; overflow: hidden` and the grid column collapses. When expanded, it restores to its previous width.

Update `TreePanel.svelte` and `BlackboardPanel.svelte` — add a collapse button in the panel-header:

```svelte
<button class="collapse-btn" onclick={() => /* emit collapse event */}>
  {collapsed ? '▸' : '◂'}
</button>
```

### Step 3: Add responsive breakpoints

Add a media query in `App.svelte` styles:

```css
@media (max-width: 900px) {
  .dash-body {
    grid-template-columns: 1fr !important;
    grid-template-rows: auto 1fr;
  }
  /* Tree panel becomes horizontal breadcrumb bar */
  .tree-panel-wrapper {
    border-right: none;
    border-bottom: 1px solid var(--border);
    max-height: 48px;
    overflow: hidden;
  }
  /* Blackboard becomes a tab alongside timeline */
  .blackboard-panel-wrapper {
    display: none; /* hidden by default, shown via tab toggle */
  }
}
```

Add a tab bar that appears at the responsive breakpoint, allowing users to switch between the Event Timeline and Blackboard views:

```svelte
{#if isNarrow}
  <div class="tab-bar">
    <button class:active={activeTab === 'events'} onclick={() => activeTab = 'events'}>Events</button>
    <button class:active={activeTab === 'blackboard'} onclick={() => activeTab = 'blackboard'}>Blackboard</button>
  </div>
{/if}
```

### Step 4: Verify build

Run: `npm run dashboard:build`
Expected: Build succeeds.

### Step 5: Commit

```bash
git add dashboard/src/App.svelte dashboard/src/components/TreePanel.svelte dashboard/src/components/BlackboardPanel.svelte
git commit -m "feat(dashboard): add panel resize, collapse, and responsive layout"
```
