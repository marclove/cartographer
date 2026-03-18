# Task 135: Per-Package Vitest Configs

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the monolithic root `vitest.config.ts` (with 7 project definitions) with per-package vitest configs. Each package/app owns its own test configuration.

**Depends on:** Task 133 (examples moved to apps/), Task 132 (dashboard moved to apps/)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-monorepo-restructure-design.md`

---

### Step 1: Create `packages/cartographer/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/__integration__/**'],
  },
});
```

The cartographer package's `test` script already runs with `NODE_OPTIONS=--experimental-eventsource` (set in task 129).

### Step 2: Create `packages/client/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

### Step 3: Create `packages/react/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    globals: true,
  },
});
```

Note: The react package uses `jsdom` environment and `globals: true` (matching the current root config).

### Step 4: Verify dashboard vitest config exists

Task 132 should have already created `apps/dashboard/vitest.config.ts` with the `svelte()` plugin. Verify it exists and is correct.

### Step 5: Handle integration and live tests

The cartographer package has integration and live test suites that are currently run via root scripts (`test:integration`, `test:live`). Add these as separate scripts in `packages/cartographer/package.json`:

```json
{
  "test": "NODE_OPTIONS=--experimental-eventsource vitest run --config vitest.config.ts",
  "test:integration": "NODE_OPTIONS=--experimental-eventsource vitest run --config vitest.integration.config.ts",
  "test:live": "NODE_OPTIONS=--experimental-eventsource vitest run --config vitest.live.config.ts"
}
```

Create `packages/cartographer/vitest.integration.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__integration__/**/*.test.ts'],
    exclude: ['src/__integration__/live/**'],
  },
});
```

Create `packages/cartographer/vitest.live.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__integration__/live/**/*.test.ts'],
  },
});
```

Add corresponding turbo tasks in `turbo.json` if desired, or keep them as manual invocations:
```bash
pnpm --filter cartographer test:integration
pnpm --filter cartographer test:live
```

### Step 6: Migrate coverage config

The root `vitest.coverage.ts` contains coverage settings for the cartographer package. Merge these into `packages/cartographer/vitest.config.ts` or create a separate coverage config:

```ts
// In packages/cartographer/vitest.config.ts, add:
coverage: {
  enabled: false, // enabled via CLI flag: vitest run --coverage
  provider: 'v8',
  include: ['src/**/*.ts'],
  exclude: [
    'src/**/*.test.ts',
    'src/__integration__/**',
    'src/index.ts',
    'src/cli/commands/**',
    'src/cli/index.ts',
  ],
  reporter: ['text'],
},
```

### Step 7: Delete root vitest configs

- Delete `vitest.config.ts` (root)
- Delete `vitest.coverage.ts` (root)

### Step 8: Update root scripts

Update the root `package.json` scripts to remove any remaining vitest-specific invocations. The root scripts should now be:

```json
{
  "build": "turbo build",
  "test": "turbo test",
  "typecheck": "turbo typecheck",
  "test:integration": "pnpm --filter cartographer test:integration",
  "test:live": "pnpm --filter cartographer test:live"
}
```

Remove `test:dashboard`, `test:examples`, `test:all`, `test:watch` if they exist — these are now handled by turbo or per-package scripts.

### Step 9: Verify all tests pass

```bash
pnpm run test
pnpm run test:integration
```

### Step 10: Commit

```bash
git add -A
git commit -m "chore: replace monolithic vitest config with per-package configs"
```
