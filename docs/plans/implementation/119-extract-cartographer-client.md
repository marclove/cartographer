# Task 119: Extract @cartographer/client Package

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the existing client SDK code (`src/client/`) into its own `@cartographer/client` package with zero framework dependencies.

**Depends on:** Task 118 (monorepo workspace setup)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md` — @cartographer/client section

---

### Context

The client code currently lives at `packages/cartographer/src/client/` (after task 118 moves it). It consists of two files:
- `types.ts` — `CartographerClient` interface and `ConflictError` class
- `index.ts` — `createCartographerClient()` factory function

This code has zero dependencies beyond browser globals (`fetch`, `EventSource`). It's a clean extraction.

### Step 1: Create package scaffold

Create `packages/client/` with:

`packages/client/package.json`:
```json
{
  "name": "@cartographer/client",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  }
}
```

`packages/client/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true
  },
  "include": ["src"]
}
```

### Step 2: Move client source files

Move from `packages/cartographer/src/client/`:
- `types.ts` → `packages/client/src/types.ts`
- `index.ts` → `packages/client/src/index.ts`

The files need no code changes — they have no imports from the main package.

### Step 3: Update main package

In `packages/cartographer/`:
- Remove `src/client/` directory
- Update `src/index.ts` to remove client re-exports (`createCartographerClient`, `CartographerClient`, `ConflictError`)
- Add `@cartographer/client` as a dependency in `packages/cartographer/package.json` (so existing internal usage like the dashboard Svelte client can import from the new package)
- Update any internal imports that referenced `./client/index.js` to import from `@cartographer/client`

### Step 4: Update existing tests

Move `packages/cartographer/src/client/index.test.ts` to `packages/client/src/index.test.ts`. Update imports to use relative paths within the new package. The test file should still work since it imports the client factory directly.

For integration tests that import from `src/client/`, update those import paths to `@cartographer/client`.

### Step 5: Verify

Run:
- `npm run build --workspace=packages/client`
- `npm run typecheck --workspace=packages/client`
- `npm run test` (all existing tests pass)
- `npm run build` (full workspace build)

### Step 6: Commit

```bash
git add -A
git commit -m "feat: extract @cartographer/client as standalone package"
```
