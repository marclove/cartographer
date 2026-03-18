# Task 132: Move Dashboard to apps/dashboard

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the dashboard a proper workspace member under `apps/dashboard/` with its own `package.json` and build config.

**Depends on:** Task 131 (dependency distribution)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-monorepo-restructure-design.md`

---

### Step 1: Create apps directory and move dashboard

```bash
mkdir -p apps
git mv dashboard apps/dashboard
```

### Step 2: Update `pnpm-workspace.yaml`

Add `apps/*` to the workspace:

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

### Step 3: Create `apps/dashboard/package.json`

```json
{
  "name": "@cartographer/dashboard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build && tsc -p tsconfig.server.json",
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.server.json",
    "test": "vitest run",
    "dev": "vite dev"
  },
  "devDependencies": {
    "svelte": "^5.53.11",
    "@sveltejs/vite-plugin-svelte": "^5.1.1",
    "vite": "^6.4.1",
    "vitest": "^3.2.4",
    "typescript": "^5.9.3"
  }
}
```

Note: Use the same version ranges as currently in the root `package.json`.

### Step 4: Update `apps/dashboard/vite.config.ts`

The `outDir` currently resolves to `../dist/dashboard` (relative to the old `dashboard/` location, targeting root `dist/`). Update it to build within the dashboard's own directory:

```ts
build: {
  outDir: path.resolve(import.meta.dirname, 'dist/client'),
  emptyOutDir: true,
}
```

### Step 5: Update `apps/dashboard/tsconfig.server.json`

The `outDir` currently targets `../dist/dashboard-server`. Update to build locally:

```json
{
  "compilerOptions": {
    "outDir": "./dist/server",
    "rootDir": "./src"
  }
}
```

Keep other compiler options unchanged (`target`, `module`, `moduleResolution`, `strict`, etc.).

### Step 6: Add turbo outputs for dashboard

The dashboard's build outputs are in `dist/client/**` and `dist/server/**`. The existing `turbo.json` already captures `dist/**`, so no change is needed.

### Step 7: Move dashboard devDependencies from root

Remove these from the root `package.json` devDependencies (they're now in the dashboard's own `package.json`):
- `svelte`
- `@sveltejs/vite-plugin-svelte`
- `vite`

Note: Keep `vite` at root if other packages still reference it. Check first.

### Step 8: Create `apps/dashboard/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

The svelte plugin is required for tests that import from `.svelte.ts` files.

### Step 9: Run pnpm install and verify

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test
```

The dashboard build will now output to `apps/dashboard/dist/` instead of root `dist/`. The CLI's dashboard path resolution will break — that's expected and addressed in task 134.

### Step 10: Commit

```bash
git add -A
git commit -m "chore: move dashboard to apps/dashboard as workspace member"
```
