# Task 33: Include Node ID in Tree Logger Output

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `nodeId` to every log entry emitted by `createTreeLogger`, so custom IDs are captured in structured logs for cross-run correlation and disambiguation of same-named nodes.

**Architecture:** In every event handler in `src/tree-logger.ts` that logs `node: node.name`, also log `nodeId: node.id`. Update corresponding test assertions.

**Tech Stack:** TypeScript, vitest

**Depends on:** Task 31 (custom IDs)

---

### Step 1: Add `nodeId` to all logger event handlers

Modify `src/tree-logger.ts`. In every event handler that writes `node: node.name`, add `nodeId: node.id`. The events that reference `node` are:

- `node:enter`
- `node:exit`
- `node:error`
- `agent:prompt`
- `agent:thinking`
- `agent:text`
- `agent:tool_use`
- `agent:response`
- `agent:error`
- `agent:stream`
- `agent:message`
- `agent:tool_progress`
- `agent:init`
- `agent:status`
- `agent:rate_limit`
- `strategy:decision` (uses `composite` instead of `node`)

For example, change:
```typescript
  on('node:enter', ({ node }) => {
    write({ event: 'node:enter', node: node.name });
  });
```
to:
```typescript
  on('node:enter', ({ node }) => {
    write({ event: 'node:enter', node: node.name, nodeId: node.id });
  });
```

For `strategy:decision`, the field is `composite` not `node`:
```typescript
  on('strategy:decision', ({ composite, strategy, decision }) => {
    write({ event: 'strategy:decision', node: composite.name, nodeId: composite.id, strategy, decision });
  });
```

### Step 2: Update tree-logger tests

Modify `src/tree-logger.test.ts`. In tests that assert on log entry shape, add `nodeId` to the expected objects. The mock nodes in those tests already have `id` fields set, so the values will match. Use `expect.objectContaining` or add `nodeId` to the exact match object, depending on the existing test style.

### Step 3: Run tests

Run: `npm run typecheck && npm run test`
Expected: All pass.

### Step 4: Commit

```bash
git add src/tree-logger.ts src/tree-logger.test.ts
git commit -m "feat: include node ID in tree logger output"
```
