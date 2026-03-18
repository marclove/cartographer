# Task 128: Migrate from npm to pnpm

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace npm with pnpm as the package manager, using `pnpm-workspace.yaml` instead of the `workspaces` field in `package.json`.

**Depends on:** None

**Spec Reference:** `docs/superpowers/specs/2026-03-18-monorepo-restructure-design.md`

---

### Step 1: Remove npm artifacts

- Delete `package-lock.json`
- Delete the root `node_modules/` directory

### Step 2: Create pnpm workspace config

Create `pnpm-workspace.yaml` at the repo root:

```yaml
packages:
  - "packages/*"
```

Note: `apps/*` will be added in a later task when apps are created. For now, only `packages/*` exists.

### Step 3: Create `.npmrc`

Create `.npmrc` at the repo root:

```ini
strict-peer-dependencies=false
```

### Step 4: Update root `package.json`

- Remove the `"workspaces": ["packages/*"]` field (pnpm uses `pnpm-workspace.yaml`)
- Keep everything else as-is for now (dependency redistribution is a later task)

### Step 5: Install with pnpm

Run `pnpm install` to generate `pnpm-lock.yaml` and link workspace packages.

### Step 6: Verify everything still works

Run the existing build, typecheck, and test commands to confirm nothing broke:

- `pnpm run build`
- `pnpm run typecheck`
- `pnpm run test`

All must pass. Fix any issues before proceeding.

### Step 7: Commit

```bash
git add pnpm-workspace.yaml .npmrc pnpm-lock.yaml package.json
git add -u  # captures package-lock.json deletion
git commit -m "chore: migrate from npm to pnpm workspaces"
```
