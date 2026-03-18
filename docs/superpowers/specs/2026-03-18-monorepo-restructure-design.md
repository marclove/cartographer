# Monorepo Restructure: pnpm + Turborepo

**Date:** 2026-03-18
**Status:** Approved

## Problem

The current monorepo has several structural issues:

- The core `cartographer` package builds to the repo root's `dist/` instead of its own
- Production dependencies are duplicated between the root `package.json` and package-level `package.json` files
- Build/typecheck scripts manually chain 5+ sequential `tsc` calls — fragile and doesn't scale
- The dashboard is not a workspace member, so its dependencies bleed into the root
- Examples share a single tsconfig that reaches into core package source directly

## Solution

Migrate from npm workspaces to pnpm workspaces + Turborepo. Restructure so each package builds to its own `dist/`, owns its own dependencies, and defines its own build/test/typecheck scripts. Turborepo orchestrates the dependency graph, caching, and parallelism.

## Directory Structure

```
cartographer/
├── apps/
│   ├── dashboard/            # Svelte dashboard app
│   │   ├── src/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vite.config.ts
│   ├── content-pipeline/     # Example app
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── scheduled-monitor/    # Example app
│       ├── package.json
│       └── tsconfig.json
├── packages/
│   ├── cartographer/         # Core BT framework
│   │   ├── src/
│   │   ├── dist/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── client/               # Browser/Node client SDK
│   │   ├── src/
│   │   ├── dist/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── react/                # React hooks
│       ├── src/
│       ├── dist/
│       ├── package.json
│       └── tsconfig.json
├── turbo.json
├── pnpm-workspace.yaml
├── .npmrc
├── package.json              # root — devDependencies only
├── tsconfig.base.json        # shared compiler options
└── .gitignore
```

## Package Dependencies

### Root `package.json`

- `devDependencies` only: `typescript`, `vitest`, `@vitest/coverage-v8`, `turbo`, `tsx`
- No `dependencies`
- No `bin` field
- No `workspaces` field (pnpm uses `pnpm-workspace.yaml`)

### `packages/cartographer`

- `dependencies`: `@anthropic-ai/claude-agent-sdk`, `cron-parser`, `uuid`, `zod`, `@cartographer/client`
- `bin`: `{ "cartographer": "./dist/cli/index.js" }`
- Exports: `./dist/index.js` (local)

### `packages/client`

- No external dependencies

### `packages/react`

- `peerDependencies`: `react >= 18`, `@cartographer/client >= 0.1.0`
- `devDependencies`: `react`, `@types/react`, `@cartographer/client`, `@testing-library/react`

### `apps/dashboard`

- `dependencies`: `cartographer`
- `devDependencies`: `svelte`, `@sveltejs/vite-plugin-svelte`, `vite`

### `apps/content-pipeline` and `apps/scheduled-monitor`

- `dependencies`: `cartographer` (and whatever each example actually imports)

## Build Orchestration

### `pnpm-workspace.yaml`

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

### `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["^build"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

`^build` means "build my workspace dependencies first." Turborepo resolves the graph: `client` first (no deps), then `cartographer` (depends on client), then `react` and apps in parallel. Cached outputs are skipped when source hasn't changed.

### Root scripts

```json
{
  "build": "turbo build",
  "test": "turbo test",
  "typecheck": "turbo typecheck",
  "dev": "turbo dev"
}
```

### Per-package scripts

Each package defines its own `build`, `test`, and `typecheck`:

```json
{
  "build": "tsc",
  "typecheck": "tsc --noEmit",
  "test": "vitest run"
}
```

Apps that use Vite replace `tsc` with `vite build` for their `build` script.

## TypeScript Configuration

### `tsconfig.base.json` (unchanged)

Shared compiler options. All packages extend this.

### Per-package `tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

- `react` adds `"jsx": "react-jsx"`
- Apps set `"noEmit": true`, no `outDir` — they run via `tsx` or bundle with Vite
- Apps import packages by name (`import { BehaviorTree } from 'cartographer'`), not by reaching into source

### Deletions

- Root `tsconfig.json` — was a duplicate of the cartographer package config
- `examples/tsconfig.json` — replaced by per-app tsconfigs

## Testing

Each package/app gets its own `vitest.config.ts` with just its include pattern and environment settings (e.g. `jsdom` for react). The root `vitest.config.ts` with 7 project definitions is removed. `turbo test` orchestrates all workspace test runs.

## pnpm Migration

1. Delete `package-lock.json`
2. Delete `node_modules/`
3. Add `pnpm-workspace.yaml`
4. Add `.npmrc` with `strict-peer-dependencies=false`
5. Remove `"workspaces"` field from root `package.json`
6. Run `pnpm install` to generate `pnpm-lock.yaml`

## Cleanup

- Delete root `dist/` directory
- Add `.turbo/` to `.gitignore`
- Move `bin` field from root to `packages/cartographer/package.json`
- Move `dashboard/tsconfig.server.json` into `apps/dashboard/`
- Update `CLAUDE.md` commands section to use `pnpm` and `turbo`
