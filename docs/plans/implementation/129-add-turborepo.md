# Task 129: Add Turborepo

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Turborepo as the build orchestrator. Configure task pipelines for build, test, typecheck, and dev.

**Depends on:** Task 128 (pnpm migration)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-monorepo-restructure-design.md`

---

### Step 1: Install turbo

```bash
pnpm add -D turbo -w
```

The `-w` flag installs at the workspace root.

### Step 2: Create `turbo.json`

Create `turbo.json` at the repo root:

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

### Step 3: Add per-package scripts

Each package in `packages/` needs its own `build`, `typecheck`, and `test` scripts so turbo can invoke them. Update the following `package.json` files:

**`packages/cartographer/package.json`** — already has `build` and `typecheck`. Add `test`:
```json
"test": "NODE_OPTIONS=--experimental-eventsource vitest run --project unit"
```

Note: The cartographer package's test script runs unit tests only. Integration and live tests are run separately and will be addressed when the root scripts are updated.

**`packages/client/package.json`** — already has `build` and `typecheck`. Add `test`:
```json
"test": "NODE_OPTIONS=--experimental-eventsource vitest run"
```

**`packages/react/package.json`** — already has `build` and `typecheck`. Add `test`:
```json
"test": "vitest run"
```

Note: The react package does not need `NODE_OPTIONS=--experimental-eventsource` — its tests use mocked clients.

### Step 4: Update root scripts

Replace the chained root scripts with turbo invocations:

```json
{
  "build": "turbo build",
  "test": "turbo test",
  "typecheck": "turbo typecheck",
  "test:integration": "NODE_OPTIONS=--experimental-eventsource vitest run --project integration",
  "test:live": "NODE_OPTIONS=--experimental-eventsource vitest run --project live",
  "test:all": "NODE_OPTIONS=--experimental-eventsource vitest run"
}
```

Keep `test:integration`, `test:live`, and `test:all` at root for now — these will be refactored when per-package vitest configs are created (task 135).

### Step 5: Update `.gitignore`

Add `.turbo/` to `.gitignore` (turborepo cache directory).

### Step 6: Verify turbo works

```bash
pnpm run build
pnpm run typecheck
pnpm run test
```

Confirm turbo runs tasks in the correct dependency order and all pass.

### Step 7: Commit

```bash
git add turbo.json .gitignore package.json packages/*/package.json pnpm-lock.yaml
git commit -m "chore: add turborepo for build orchestration"
```
