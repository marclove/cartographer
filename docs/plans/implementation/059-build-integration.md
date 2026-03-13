# Task 59: Build Integration and End-to-End Verification

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Verify the full pipeline works end-to-end: TypeScript build, Svelte build, static asset serving, SSE streaming to the browser. Add the dashboard build output to the npm package files list. Final verification.

**Depends on:** Tasks 50–60

---

### Step 1: Verify the full build

Run: `npm run build`
Expected: Two stages complete:
1. `tsc` compiles server code to `dist/`
2. `vite build` compiles dashboard to `dist/dashboard/`

Verify output:

```bash
ls dist/server/
```
Expected: `dashboard-server.js`, `api-handlers.js`, `sse-handler.js`, `serializers.js`, `event-buffer.js`, `index.js` (and corresponding `.d.ts` files).

```bash
ls dist/dashboard/
```
Expected: `index.html`, `assets/` directory with `.js` and `.css` bundles.

### Step 2: Update package.json files list

Edit `package.json` — ensure `dist/dashboard/` is included in the package when published. If a `"files"` array exists, add `"dist/dashboard"` to it. If not, the default includes `dist/` so no change is needed. Verify:

```bash
npm pack --dry-run 2>&1 | grep dashboard
```
Expected: `dist/dashboard/index.html` and `dist/dashboard/assets/*` appear in the pack list.

### Step 3: Run all existing tests

Run: `npm run test`
Expected: All unit tests pass. No regressions from the server or dashboard additions.

Run: `npm run test:integration`
Expected: All integration tests pass, including the new server integration tests from Tasks 48-49.

### Step 4: Run typecheck

Run: `npm run typecheck`
Expected: All pass.

### Step 5: End-to-end smoke test

Run an example tree with the dashboard:

```bash
npm run build && node dist/cli/index.js run examples/simple-sequence.ts
```

Expected output includes: `Dashboard: http://localhost:3147` on stderr.

In another terminal, verify the API responds:

```bash
curl -s http://localhost:3147/api/tree | head -c 200
curl -s http://localhost:3147/api/status
curl -s http://localhost:3147/api/blackboard
```

Expected: JSON responses for each endpoint.

Verify the dashboard loads:

```bash
curl -s http://localhost:3147/ | head -c 100
```

Expected: HTML content starting with `<!DOCTYPE html>`.

Verify SSE stream connects (will output events then the connection stays open):

```bash
curl -s -N http://localhost:3147/api/events | head -20
```

Expected: An `event: snapshot` message with tree and blackboard data.

### Step 6: Verify --no-serve suppresses server

```bash
node dist/cli/index.js run --no-serve examples/simple-sequence.ts
```

Expected: No `Dashboard:` message. Port 3147 is not bound.

### Step 7: Add .superpowers to .gitignore if not present

Check if `.superpowers/` is already in `.gitignore`. If not, add it:

```
.superpowers/
```

### Step 8: Final commit

```bash
git add package.json .gitignore
git commit -m "chore: finalize dashboard build integration and package config"
```
