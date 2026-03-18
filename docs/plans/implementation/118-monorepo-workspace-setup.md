# Task 118: Monorepo Workspace Setup

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert the project from a single package to an npm workspaces monorepo so that `@cartographer/client` and `@cartographer/react` can live alongside the existing `cartographer` package.

**Depends on:** None

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md`

---

### Context

The project is currently a flat single-package layout with source in `src/`, tests co-located, and a single `package.json` at the root. We need to restructure into:

```
packages/
  cartographer/        # existing code moves here
  client/              # @cartographer/client (task 119)
  react/               # @cartographer/react (task 120)
package.json           # root workspace config
```

### Step 1: Create root workspace package.json

Update the root `package.json` to become a workspace root. Keep existing devDependencies that are shared (vitest, typescript, etc.) at the root. Add the `workspaces` field:

```json
{
  "private": true,
  "workspaces": ["packages/*"]
}
```

Move non-workspace-root fields (name, version, type, exports, main, bin, dependencies) into `packages/cartographer/package.json`.

### Step 2: Move existing code into packages/cartographer

Create `packages/cartographer/` and move:
- `src/` → `packages/cartographer/src/`
- `tsconfig.json` → `packages/cartographer/tsconfig.json` (adjust paths)
- Create `packages/cartographer/package.json` with the existing package metadata

Keep at the root:
- `vitest.config.ts` (or workspace-level vitest config)
- Root `tsconfig.json` as a base config that packages extend
- `package.json` as workspace root
- `.gitignore`, `CLAUDE.md`, `docs/`, `dashboard/`

### Step 3: Update import paths and tsconfig

- Ensure `packages/cartographer/tsconfig.json` has correct `rootDir`, `outDir`, `include`
- Update any absolute path references in the codebase
- The `src/` prefix in imports should still work since the source moves as a unit

### Step 4: Update build and test scripts

Root `package.json` scripts should delegate to workspaces:

```json
{
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "typecheck": "npm run typecheck --workspaces"
  }
}
```

`packages/cartographer/package.json`:

```json
{
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  }
}
```

### Step 5: Verify build and tests pass

Run:
- `npm install` (workspace linking)
- `npm run build`
- `npm run test`
- `npm run typecheck`

All existing tests must pass without modification.

### Step 6: Commit

```bash
git add -A
git commit -m "chore: restructure into npm workspaces monorepo"
```
