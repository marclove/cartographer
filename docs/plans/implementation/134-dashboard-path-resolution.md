# Task 134: Fix Dashboard Path Resolution in CLI

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the cartographer CLI's ability to locate and start the dashboard after it moved to `apps/dashboard/` and the core package now builds to its own `dist/`.

**Depends on:** Task 132 (dashboard moved to apps/)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-monorepo-restructure-design.md` — "Dashboard Path Resolution" section

---

### Context

The CLI in `packages/cartographer/src/cli/commands/shared.ts` currently resolves the dashboard via relative `import.meta.url` paths:

```ts
const dashboardServerPath = new URL('../../dashboard-server/server.js', options.importMetaUrl);
const staticDir = new URL('../../dashboard/', options.importMetaUrl);
```

These paths resolved relative to `dist/cli/commands/` (root dist). Now that:
1. The core package builds to `packages/cartographer/dist/`
2. The dashboard builds to `apps/dashboard/dist/`

The relative paths are broken. We'll use the spec's Option 2: resolve via package name.

### Step 1: Write test for dashboard resolution

Add a test in `packages/cartographer/src/cli/commands/shared.test.ts` (or the existing CLI test file) that verifies the `startDashboard` function can resolve the dashboard module. The test should mock the dynamic import and verify the correct module is being imported.

```ts
// Test that startDashboard imports from '@cartographer/dashboard'
// and passes the correct staticDir and server class
```

### Step 2: Add exports to dashboard package

Update `apps/dashboard/package.json` to export the server class and static dir path:

```json
{
  "exports": {
    "./server": {
      "types": "./dist/server/server.d.ts",
      "import": "./dist/server/server.js"
    },
    "./static-dir": {
      "types": "./static-dir.d.ts",
      "import": "./static-dir.js"
    }
  }
}
```

Create `apps/dashboard/static-dir.js`:
```js
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const staticDir = path.resolve(
  fileURLToPath(import.meta.url),
  '..',
  'dist',
  'client'
);
```

Create `apps/dashboard/static-dir.d.ts`:
```ts
export declare const staticDir: string;
```

This approach lets the CLI import the dashboard by package name without knowing the filesystem layout.

### Step 3: Add dashboard as optional dependency of cartographer

In `packages/cartographer/package.json`, add the dashboard as an `optionalDependency`:

```json
"optionalDependencies": {
  "@cartographer/dashboard": "workspace:*"
}
```

Using `optionalDependencies` means the cartographer package can be installed without the dashboard (e.g. in production deployments that don't need the UI). The CLI's `startDashboard` function already gracefully handles the dashboard not being available (returns `null`).

### Step 4: Update `startDashboard` in shared.ts

Rewrite the `startDashboard` function to import by package name:

```ts
export async function startDashboard(options: {
  apiPort: number;
  dashboardPort?: number;
  quiet?: boolean;
}): Promise<DashboardHandle | null> {
  try {
    const { DashboardServer } = await import('@cartographer/dashboard/server');
    const { staticDir } = await import('@cartographer/dashboard/static-dir');
    const server = new DashboardServer({
      port: options.dashboardPort,
      staticDir,
      apiUrl: `http://localhost:${options.apiPort}`,
    });
    const { port } = await server.start();
    if (!options.quiet) {
      process.stderr.write(`Dashboard: http://localhost:${port}\n`);
    }
    return { port, close: () => server.close() };
  } catch {
    if (!options.quiet) {
      process.stderr.write('Dashboard: not available (run pnpm build first)\n');
    }
    return null;
  }
}
```

Note: The `importMetaUrl` parameter is no longer needed and can be removed from the function signature. Update all call sites accordingly.

### Step 5: Update call sites

Find all callers of `startDashboard` and remove the `importMetaUrl` argument. The main caller is in `packages/cartographer/src/cli/commands/run.ts`.

### Step 6: Verify

```bash
pnpm run build
pnpm run test
```

Also manually test the CLI dashboard startup if possible:
```bash
pnpm --filter cartographer exec cartographer run --serve --no-tick <some-tree-file>
```

### Step 7: Commit

```bash
git add -A
git commit -m "fix: resolve dashboard by package name instead of relative paths"
```
