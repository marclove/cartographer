# Task 51: Svelte Project Scaffolding and Build Pipeline

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Set up the Svelte 5 + Vite project structure in `dashboard/`, configure the build to output to `dist/dashboard/`, and wire up npm scripts.

**Depends on:** Task 50 (server serves static files from `dist/dashboard/`)

---

### Step 1: Install dev dependencies

```bash
npm install -D svelte @sveltejs/vite-plugin-svelte vite
```

### Step 2: Create Vite config

Create `dashboard/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';

export default defineConfig({
  plugins: [svelte()],
  root: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, '../dist/dashboard'),
    emptyOutDir: true,
  },
});
```

### Step 3: Create svelte config

Create `dashboard/svelte.config.js`:

```js
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
};
```

### Step 4: Create HTML entry point

Create `dashboard/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cartographer Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

### Step 5: Create TypeScript config for dashboard

Create `dashboard/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "preserve",
    "types": ["svelte"],
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*.ts", "src/**/*.svelte"]
}
```

### Step 6: Create app entry point

Create `dashboard/src/main.ts`:

```ts
import App from './App.svelte';
import { mount } from 'svelte';

const app = mount(App, { target: document.getElementById('app')! });

export default app;
```

### Step 7: Create placeholder App component

Create `dashboard/src/App.svelte`:

```svelte
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
```

### Step 8: Add npm scripts

Edit `package.json` — add to `"scripts"`:

```json
"dashboard:build": "vite build --config dashboard/vite.config.ts",
"dashboard:dev": "vite dev --config dashboard/vite.config.ts"
```

Update the existing `"build"` script to include the dashboard:

```json
"build": "tsc && npm run dashboard:build"
```

### Step 9: Add dashboard build output to .gitignore

Append to `.gitignore`:

```
dist/dashboard/
```

### Step 10: Verify the build

Run: `npm run dashboard:build`
Expected: Build succeeds, outputs files to `dist/dashboard/` (index.html, JS bundle, CSS).

Run: `ls dist/dashboard/`
Expected: `index.html` and an `assets/` directory with `.js` and `.css` files.

### Step 11: Verify end-to-end static serving

Run: `npm run build`
Expected: TypeScript compiles, then dashboard builds.

Quick check that the server can serve the built files — this will be verified more thoroughly in Task 59.

### Step 12: Commit

```bash
git add dashboard/ package.json .gitignore
git commit -m "feat(dashboard): scaffold Svelte 5 + Vite project with build pipeline"
```
