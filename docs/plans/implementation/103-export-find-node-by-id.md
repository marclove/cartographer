# Task 103: Export `findNodeById` from api-handlers

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Export the `findNodeById` helper so ActorServer can reuse it for the `/api/nodes/:id` endpoint.

**Depends on:** None

---

### Context

`findNodeById` in `src/server/api-handlers.ts` (line 68) is currently a private function. ActorServer needs it to implement `GET /api/nodes/:id`. Export it so both servers can use it.

### Files

- Modify: `src/server/api-handlers.ts` (line 68 — change `function` to `export function`)

---

- [ ] **Step 1: Export the function**

Edit `src/server/api-handlers.ts` line 68:

Change:
```ts
function findNodeById(root: BTreeNode, id: string): BTreeNode | undefined {
```
To:
```ts
export function findNodeById(root: BTreeNode, id: string): BTreeNode | undefined {
```

- [ ] **Step 2: Verify no regressions**

Run: `npm run test`
Expected: All tests pass (export-only change)

- [ ] **Step 3: Commit**

```bash
git add src/server/api-handlers.ts
git commit -m "refactor(server): export findNodeById for reuse by ActorServer"
```
