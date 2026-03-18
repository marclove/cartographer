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

All packages and apps must set `"type": "module"` in their `package.json`.

### Root `package.json`

- `devDependencies` only: `typescript`, `vitest`, `@vitest/coverage-v8`, `turbo`
- No `dependencies`
- No `bin` field
- No `workspaces` field (pnpm uses `pnpm-workspace.yaml`)

### `packages/cartographer`

- `dependencies`: `@anthropic-ai/claude-agent-sdk`, `cron-parser`, `tsx`, `uuid`, `zod`
- `devDependencies`: `@cartographer/client` (reclassified from `dependencies` — only used in integration tests, not in production source)
- `bin`: `{ "cartographer": "./dist/cli/index.js" }`
- `main`: `./dist/index.js`, `types`: `./dist/index.d.ts` (currently points to `../../dist/` — must be updated)
- `exports`: `{ ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }`

Note: `tsx` is a runtime dependency — the CLI dynamically imports `tsx/esm/api` to load TypeScript config files. `yaml` is listed in CLAUDE.md's architecture section but is not currently imported anywhere in source — it is not included.

### `packages/client`

- No external dependencies

### `packages/react`

- `peerDependencies`: `react >= 18`, `@cartographer/client >= 0.1.0`
- `devDependencies`: `react`, `react-dom`, `@types/react`, `@types/react-dom`, `@cartographer/client`, `@testing-library/react`, `jsdom`

### `apps/dashboard`

The dashboard is a standalone Svelte + Node app. It does not depend on `cartographer` — the dependency is reversed: the cartographer CLI dynamically imports the dashboard's build output at runtime. See the "Dashboard Path Resolution" section below.

- `devDependencies`: `svelte`, `@sveltejs/vite-plugin-svelte`, `vite`, `typescript`, `vitest`

### `apps/content-pipeline` and `apps/scheduled-monitor`

- `dependencies`: `cartographer`, `zod` (both examples import directly from `zod/v4`)

Note: Under pnpm's strict isolation, transitive dependencies are not accessible. Each app must explicitly declare everything it imports.

## Dashboard Path Resolution

The cartographer CLI currently resolves the dashboard via relative paths from its own built JS:

```ts
// packages/cartographer/src/cli/commands/shared.ts
const dashboardServerPath = new URL('../../dashboard-server/server.js', import.meta.url);
const staticDir = new URL('../../dashboard/', options.importMetaUrl);
```

These paths resolve relative to `dist/cli/commands/` (root dist). After the migration, the cartographer package builds to `packages/cartographer/dist/`, so these paths will break.

**Resolution strategy:** The dashboard build output (`vite build` for static assets, `tsc` for the server) should be placed in a location the CLI can resolve. Options:

1. **Copy dashboard output into cartographer's dist at build time** — turbo can orchestrate this via the dependency graph (dashboard builds first, cartographer copies)
2. **Resolve via package name** — make the dashboard export its server and static paths, and have the CLI `import('dashboard')` to get them. This is cleaner but requires the dashboard to be a proper dependency of cartographer.
3. **Use a build-time constant** — inject the dashboard path at build time via an environment variable or config file.

Option 2 is the cleanest long-term. The dashboard becomes a workspace dependency of `packages/cartographer` (as a `devDependency` or `optionalDependency`), exports the server class and static dir path, and the CLI imports it by name. This should be finalized during implementation planning.

## Build Orchestration

### `pnpm-workspace.yaml`

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

Note: The dashboard and example apps are being added to the workspace graph for the first time. They are not currently workspace members under npm.

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

Apps that use Vite replace `tsc` with `vite build` for their `build` script. The dashboard is a special case — it needs both `vite build` (Svelte frontend) and `tsc -p tsconfig.server.json` (Node server), so its build script chains both: `"build": "vite build && tsc -p tsconfig.server.json"`.

### `NODE_OPTIONS=--experimental-eventsource`

The current test scripts all use `NODE_OPTIONS=--experimental-eventsource` because the client package uses `EventSource`, which requires this flag on Node < 23. This must be preserved in per-package test scripts that need it:

```json
{
  "test": "NODE_OPTIONS=--experimental-eventsource vitest run"
}
```

Affected packages: `client`, `cartographer` (integration tests). The `react` package tests use mocked clients and don't exercise real `EventSource`, so the flag is not required there. Alternatively, this can be set in each package's `vitest.config.ts` via the `env` option, or the minimum Node version can be raised to 23+ where `EventSource` is stable.

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

- `react` adds `"jsx": "react-jsx"` and excludes `**/*.test.tsx` and `**/test-utils.ts`
- Apps set `"noEmit": true`, no `outDir` — they run via `tsx` or bundle with Vite
- Apps import packages by name (`import { BehaviorTree } from 'cartographer'`), not by reaching into source

### Deletions

- Root `tsconfig.json` — was a duplicate of the cartographer package config. The root `tsconfig.base.json` remains as the shared base.
- `examples/tsconfig.json` — replaced by per-app tsconfigs

## Testing

Each package/app gets its own `vitest.config.ts` with just its include pattern and environment settings (e.g. `jsdom` for react). The root `vitest.config.ts` with 7 project definitions is removed. `turbo test` orchestrates all workspace test runs.

The root `vitest.coverage.ts` is either migrated into the cartographer package's vitest config (as a coverage configuration) or removed.

The dashboard's vitest config must include the `svelte()` vite plugin (as the current root config does) for Svelte component tests to work.

## pnpm Migration

1. Delete `package-lock.json`
2. Delete root `node_modules/`
3. Add `pnpm-workspace.yaml`
4. Add `.npmrc` with `strict-peer-dependencies=false`
5. Remove `"workspaces"` field from root `package.json`
6. Run `pnpm install` to generate `pnpm-lock.yaml`

## Cleanup

- Delete root `dist/` directory (build artifact from old setup)
- Delete root `tsconfig.json` (duplicate of cartographer config)
- Delete root `vitest.config.ts` (replaced by per-package configs)
- Delete `examples/tsconfig.json` (replaced by per-app configs)
- Add `.turbo/` to `.gitignore`
- Move `bin` field from root to `packages/cartographer/package.json`
- Move `dashboard/tsconfig.server.json` into `apps/dashboard/`
- Update `packages/cartographer/package.json` exports from `../../dist/` to `./dist/`
- Remove `@types/uuid` from root devDependencies (`uuid` v13 ships its own types)
- Update `CLAUDE.md` commands section to use `pnpm` and `turbo`
