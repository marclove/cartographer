<script lang="ts">
  // Placeholder — panels added in subsequent tasks
</script>

<div class="dashboard">
  <header class="dash-header">
    <div class="dash-logo">◆ Cartographer</div>
    <div>Dashboard loading...</div>
  </header>
  <main class="dash-body">
    <p>Connected. Panels coming in subsequent tasks.</p>
  </main>
</div>

<style>
  :global(body) {
    margin: 0;
    padding: 0;
    background: #0a0e17;
    color: #c8d1dc;
    font-family: 'Inter', -apple-system, sans-serif;
  }
  .dashboard {
    min-height: 100vh;
  }
  .dash-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    background: #0d1220;
    border-bottom: 1px solid #1e2a3a;
  }
  .dash-logo {
    font-weight: 700;
    font-size: 15px;
    color: #e8ecf1;
  }
  .dash-body {
    padding: 20px;
  }
</style>
