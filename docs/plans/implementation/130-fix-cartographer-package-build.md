# Task 130: Fix Cartographer Package Build Paths

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the `cartographer` core package build to its own `dist/` directory instead of the repo root's `dist/`. Update all related paths and config.

**Depends on:** Task 129 (turborepo)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-monorepo-restructure-design.md`

---

### Step 1: Update cartographer tsconfig

Edit `packages/cartographer/tsconfig.json`:

Change `"outDir": "../../dist"` to `"outDir": "./dist"`.

The `rootDir` should remain `"./src"` and `include` should remain `["src/**/*"]`.

### Step 2: Update cartographer package.json exports

Edit `packages/cartographer/package.json`:

- Change `"main"` from `"../../dist/index.js"` to `"./dist/index.js"`
- Change `"types"` from `"../../dist/index.d.ts"` to `"./dist/index.d.ts"`
- Update `"exports"` to:
  ```json
  {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
  ```

### Step 3: Move `bin` from root to cartographer

Remove the `"bin"` field from the root `package.json`:
```json
"bin": {
  "cartographer": "./dist/cli/index.js"
}
```

Add it to `packages/cartographer/package.json`:
```json
"bin": {
  "cartographer": "./dist/cli/index.js"
}
```

### Step 4: Delete root `tsconfig.json`

The root `tsconfig.json` currently compiles `packages/cartographer/src` to `./dist`. This is now handled by the cartographer package's own tsconfig. Delete it.

Keep `tsconfig.base.json` — that's the shared base config.

### Step 5: Reclassify `@cartographer/client`

In `packages/cartographer/package.json`, move `@cartographer/client` from `dependencies` to `devDependencies`. It is only imported in `__integration__/` test files, not production source.

### Step 6: Delete root `dist/`

Delete the `dist/` directory at the repo root. It was a build artifact from the old setup. Add `dist/` to the root `.gitignore` if not already present.

Also add `dist/` to `packages/cartographer/.gitignore` (or ensure it's covered by a parent `.gitignore` pattern).

### Step 7: Rebuild and verify

```bash
pnpm run build
pnpm run typecheck
pnpm run test
```

All must pass. The `packages/cartographer/dist/` directory should now contain the compiled output.

### Step 8: Commit

```bash
git add -A
git commit -m "chore: cartographer package builds to its own dist/"
```
