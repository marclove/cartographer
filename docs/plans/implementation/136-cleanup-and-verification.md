# Task 136: Cleanup and Final Verification

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Clean up remaining artifacts from the old structure and verify the complete monorepo works end-to-end. Update documentation.

**Depends on:** Tasks 128–135 (all prior restructuring tasks)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-monorepo-restructure-design.md`

---

### Step 1: Verify directory structure matches spec

Confirm the repo now has:
```
apps/
  dashboard/
  content-pipeline/
  scheduled-monitor/
packages/
  cartographer/
  client/
  react/
turbo.json
pnpm-workspace.yaml
.npmrc
tsconfig.base.json
package.json
```

And that these no longer exist:
- Root `dist/`
- Root `tsconfig.json` (only `tsconfig.base.json` remains)
- Root `vitest.config.ts`
- Root `vitest.coverage.ts`
- `examples/` directory
- `package-lock.json`

### Step 2: Verify `.gitignore`

Ensure `.gitignore` covers:
- `node_modules/`
- `dist/`
- `.turbo/`
- `pnpm-lock.yaml` should NOT be gitignored (it should be committed)

### Step 3: Verify root `package.json` is clean

Confirm:
- No `dependencies` section (only `devDependencies`)
- No `bin` field
- No `workspaces` field
- `devDependencies` contains only shared tooling: `typescript`, `vitest`, `@vitest/coverage-v8`, `turbo`
- Scripts use `turbo` commands

### Step 4: Update CLAUDE.md

Update the Commands section to reflect the new setup:

```markdown
## Commands

\`\`\`bash
pnpm run build              # Build all packages (via turbo)
pnpm run test               # Run unit tests across all packages (via turbo)
pnpm run typecheck           # Type-check all packages (via turbo)
pnpm run test:integration    # Run integration tests (cartographer package)
pnpm run test:live           # Run live API tests (requires ANTHROPIC_API_KEY)

# Per-package commands
pnpm --filter cartographer test              # Run cartographer unit tests
pnpm --filter @cartographer/client test      # Run client tests
pnpm --filter @cartographer/react test       # Run react tests
pnpm --filter @cartographer/dashboard test   # Run dashboard tests
\`\`\`
```

Also update the Architecture section if any paths or descriptions have changed (e.g., dashboard location).

### Step 5: Full verification

Run the complete suite from the repo root:

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run test:integration
```

All must pass.

### Step 6: Verify turbo caching

Run `pnpm run build` twice. The second run should show cached results for all packages (confirming turbo caching works).

### Step 7: Commit

```bash
git add -A
git commit -m "chore: finalize monorepo restructure, update documentation"
```
