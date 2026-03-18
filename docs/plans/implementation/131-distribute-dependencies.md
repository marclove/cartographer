# Task 131: Distribute Dependencies to Owning Packages

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move production dependencies from the root `package.json` to the packages that actually use them. The root should only have shared dev tooling.

**Depends on:** Task 130 (cartographer build paths)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-monorepo-restructure-design.md`

---

### Step 1: Audit current root dependencies

The root `package.json` currently has:

**dependencies** (all should move or be removed):
- `@anthropic-ai/claude-agent-sdk` → `packages/cartographer`
- `cron-parser` → `packages/cartographer`
- `tsx` → `packages/cartographer` (runtime dep — CLI dynamically imports `tsx/esm/api`)
- `uuid` → `packages/cartographer`
- `zod` → `packages/cartographer`

**devDependencies** (keep at root or redistribute):
- `typescript` — keep at root (shared tooling)
- `vitest` — keep at root (shared tooling)
- `@vitest/coverage-v8` — keep at root
- `turbo` — keep at root (added in task 129)
- `@sveltejs/vite-plugin-svelte` — move to dashboard (task 132)
- `@testing-library/react` — move to `packages/react`
- `@types/react` — move to `packages/react`
- `@types/react-dom` — move to `packages/react`
- `@types/uuid` — remove entirely (`uuid` v13 ships its own types)
- `jsdom` — move to `packages/react`
- `react` — move to `packages/react`
- `react-dom` — move to `packages/react`
- `svelte` — move to dashboard (task 132)
- `vite` — move to dashboard (task 132)

### Step 2: Move production deps to cartographer

Verify `packages/cartographer/package.json` already declares these in `dependencies`:
- `@anthropic-ai/claude-agent-sdk`
- `cron-parser`
- `tsx`
- `uuid`
- `zod`

If any are missing, add them. Then remove the entire `"dependencies"` section from the root `package.json`.

### Step 3: Move react-related devDeps to react package

Update `packages/react/package.json` `devDependencies` to include:
- `react`
- `react-dom`
- `@types/react`
- `@types/react-dom`
- `@cartographer/client`
- `@testing-library/react`
- `jsdom`

Remove these from the root `package.json` devDependencies.

### Step 4: Remove `@types/uuid`

Remove `@types/uuid` from root devDependencies. The `uuid` v13 package ships its own TypeScript types.

### Step 5: Keep dashboard deps at root temporarily

The dashboard-related devDependencies (`svelte`, `@sveltejs/vite-plugin-svelte`, `vite`) will be moved when the dashboard becomes a workspace member (task 132). Leave them at root for now.

### Step 6: Run pnpm install and verify

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test
```

All must pass. pnpm's strict isolation will immediately reveal any missing declarations.

### Step 7: Commit

```bash
git add package.json packages/*/package.json pnpm-lock.yaml
git commit -m "chore: distribute dependencies to owning packages"
```
