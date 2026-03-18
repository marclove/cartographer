# Task 133: Move Examples to apps/

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert each example into its own workspace app under `apps/` with proper `package.json`, `tsconfig.json`, and package-name imports.

**Depends on:** Task 132 (dashboard moved to apps/)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-monorepo-restructure-design.md`

---

### Step 1: Move example directories

```bash
git mv examples/content-pipeline apps/content-pipeline
git mv examples/scheduled-monitor apps/scheduled-monitor
```

Delete the now-empty `examples/` directory and its `tsconfig.json`:
```bash
rm examples/tsconfig.json
rm examples/README.md
rmdir examples
```

### Step 2: Create `apps/content-pipeline/package.json`

```json
{
  "name": "@cartographer/example-content-pipeline",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "cartographer": "workspace:*",
    "zod": "^4.3.6"
  }
}
```

### Step 3: Create `apps/scheduled-monitor/package.json`

```json
{
  "name": "@cartographer/example-scheduled-monitor",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "cartographer": "workspace:*",
    "zod": "^4.3.6"
  }
}
```

### Step 4: Create per-app tsconfigs

**`apps/content-pipeline/tsconfig.json`:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["*.ts"],
  "exclude": ["*.test.ts"]
}
```

**`apps/scheduled-monitor/tsconfig.json`:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["*.ts"],
  "exclude": ["*.test.ts"]
}
```

### Step 5: Update imports in both examples

Both examples currently import from `../../packages/cartographer/src/index.js` (reaching into source). Replace all these imports with the package name.

**In `apps/content-pipeline/`**, update all `.ts` files:
- `from '../../packages/cartographer/src/index.js'` → `from 'cartographer'`

Files to update: `tree.ts`, `index.ts`, `actions.ts`, `prompts.ts`, `content-pipeline.test.ts`

**In `apps/scheduled-monitor/`**, update all `.ts` files:
- `from '../../packages/cartographer/src/index.js'` → `from 'cartographer'`

Files to update: `tree.ts`, `index.ts`, `actions.ts`, `prompts.ts`, `scheduled-monitor.test.ts`

### Step 6: Create per-app vitest configs (if examples have tests)

Both examples have test files. Create `vitest.config.ts` for each:

**`apps/content-pipeline/vitest.config.ts`:**
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*.test.ts'],
  },
});
```

**`apps/scheduled-monitor/vitest.config.ts`:**
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*.test.ts'],
  },
});
```

Add `test` scripts to both package.json files:
```json
"test": "vitest run"
```

### Step 7: Update root scripts

Remove `test:examples` from the root `package.json` scripts if it exists (turbo handles this now).

### Step 8: Run pnpm install and verify

```bash
pnpm install
pnpm run build
pnpm run typecheck
```

The examples should typecheck successfully against the built `cartographer` package (imported by name, not by source path).

Run example tests:
```bash
pnpm --filter @cartographer/example-content-pipeline test
pnpm --filter @cartographer/example-scheduled-monitor test
```

### Step 9: Commit

```bash
git add -A
git commit -m "chore: move examples to apps/ as workspace members"
```
