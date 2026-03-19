# Task 21: Svelte Package — Project Setup

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Initialize the `@cartographer/svelte` package with all dependencies, build config, test runner, and directory structure.

**Architecture:** ESM-only Svelte 5 package in the monorepo at `packages/svelte/`. Uses `svelte-package` for building (produces `.svelte`, `.svelte.ts`, `.js`, and `.d.ts` files). Vitest with `@sveltejs/vite-plugin-svelte` for testing Svelte 5 runes and components.

**Tech Stack:** TypeScript, Svelte 5, Vitest, `@testing-library/svelte`, `@sveltejs/vite-plugin-svelte`

---

### Step 1: Create package.json

Create `packages/svelte/package.json`:

```json
{
  "name": "@cartographer/svelte",
  "version": "0.1.0",
  "description": "Svelte 5 runes for Cartographer behavior trees",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "svelte": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "svelte": "./dist/index.js",
  "peerDependencies": {
    "svelte": "^5.0.0",
    "@cartographer/client": ">=0.1.0"
  },
  "devDependencies": {
    "@cartographer/client": "workspace:*",
    "@sveltejs/vite-plugin-svelte": "^5.1.1",
    "@testing-library/svelte": "^5.2.7",
    "jsdom": "^27.0.1",
    "svelte": "^5.53.11"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "license": "Apache-2.0"
}
```

### Step 2: Create tsconfig.json

Create `packages/svelte/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts", "**/*.test.svelte.ts", "**/test-utils.svelte.ts"]
}
```

Note: The Svelte compiler handles `.svelte` files. TypeScript handles `.ts` and `.svelte.ts` files. The exact build pipeline may need adjustment during implementation — `svelte-package` or `tsc` with the Svelte preprocessor. Verify that `tsc` can handle `.svelte.ts` files; if not, switch to `svelte-package` for the build step.

### Step 3: Create vitest.config.ts

Create `packages/svelte/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte({ hot: false })],
  test: {
    include: ['src/**/*.test.{ts,svelte.ts}'],
    environment: 'jsdom',
    globals: true,
  },
});
```

### Step 4: Create directory structure

Create the `src/` directory under `packages/svelte/`.

### Step 5: Create placeholder index.ts

Create `packages/svelte/src/index.ts`:

```ts
// @cartographer/svelte — Svelte 5 runes for Cartographer behavior trees
```

### Step 6: Install dependencies

Run from the monorepo root:

```bash
pnpm install
```

This should pick up the new package from pnpm workspaces.

### Step 7: Verify setup

Run:

```bash
pnpm --filter @cartographer/svelte test
```

Expected: Vitest runs with no tests found (or exits cleanly).

### Step 8: Commit

```bash
git add packages/svelte/
git commit -m "chore: initialize @cartographer/svelte package"
```
