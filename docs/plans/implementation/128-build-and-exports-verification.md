# Task 128: Build Verification and Package Exports

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Verify all three packages build cleanly, exports are correct, and the full test suite passes.

**Depends on:** Task 127 (all tests written)

**Spec Reference:** `docs/superpowers/specs/2026-03-18-react-integration-design.md`

---

### Step 1: Verify @cartographer/client exports

Confirm `packages/client/src/index.ts` exports exactly:
- `createCartographerClient`
- `CartographerClient` (type)
- `ConflictError`

Build: `npm run build --workspace=packages/client`

### Step 2: Verify @cartographer/react exports

Confirm `packages/react/src/index.ts` exports exactly:
- `CartographerProvider`
- `useBlackboard`
- `useBlackboardSnapshot`
- `useTreeStatus`
- `useAction`
- `useClientEvent`
- `useTreeEvent`
- `useConnectionStatus`
- `useClient`
- `TreeStatusInfo` (type)
- `ConnectionStatus` (type)

Build: `npm run build --workspace=packages/react`

### Step 3: Verify main cartographer package

Confirm `packages/cartographer/src/index.ts` no longer exports client SDK symbols. Internal imports that used `./client/index.js` now import from `@cartographer/client`.

Build: `npm run build --workspace=packages/cartographer`

### Step 4: Full workspace verification

Run from root:
- `npm run build` — all workspaces build
- `npm run typecheck` — all workspaces typecheck
- `npm run test` — existing unit tests pass
- `npm run test:integration` — existing integration tests pass
- `npx vitest run packages/react/` — react package tests pass
- `npx vitest run packages/client/` — client package tests pass

### Step 5: Verify package.json fields

For each of `packages/client/package.json` and `packages/react/package.json`, verify:
- `"type": "module"` is set
- `"exports"` field has correct `types` and `default` paths
- `"files"` includes `dist`
- Peer dependencies are correct (`react >=18` and `@cartographer/client` for the react package)

### Step 6: Commit

If any fixes were needed:

```bash
git add -A
git commit -m "chore: finalize package exports and build verification"
```
