# Task 151: Update Server and Dashboard API

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update `actor-server.ts` and `api-handlers.ts` to use `Agent.getInfo()` for agent introspection instead of the old `agentOptions` getter that returned raw SDK options.

**Architecture:** `api-handlers.ts` currently checks `node instanceof AgentNode` and reads `node.agentOptions.model`, `.allowedTools`, `.mcpServers`. After this change, it reads from `node.agentOptions` which now returns `AgentInfo` (delegated from `agent.getInfo()` in task 148).

**Tech Stack:** TypeScript

**Spec:** `docs/superpowers/specs/2026-03-22-extract-agent-definition-design.md` — see "AgentNode Changes" section.

**Dependencies:** Task 148 (refactored AgentNode with updated `agentOptions` getter)

---

### Step 1: Read current server code

Read `packages/cartographer/src/server/api-handlers.ts` lines 46-51 where `agentOptions` is used:

```typescript
if (node instanceof AgentNode) {
  const opts = node.agentOptions;
  if (opts.model) detail.model = opts.model;
  detail.tools = opts.allowedTools ?? [];
  detail.mcpServers = opts.mcpServers ? Object.keys(opts.mcpServers) : [];
}
```

After task 148, `agentOptions` returns `AgentInfo` which has `{ name, model?, tools?, [key: string]: unknown }`. The field names differ slightly: `tools` instead of `allowedTools`, and `mcpServers` is no longer guaranteed to be an object with keys.

### Step 2: Update api-handlers.ts

Modify `packages/cartographer/src/server/api-handlers.ts`:

```typescript
if (node instanceof AgentNode) {
  const info = node.agentOptions;
  if (info.model) detail.model = info.model;
  detail.tools = info.tools ?? [];
  detail.mcpServers = Array.isArray(info.mcpServers)
    ? info.mcpServers
    : info.mcpServers ? Object.keys(info.mcpServers as Record<string, unknown>) : [];
}
```

### Step 3: Verify typecheck and existing server tests pass

Run: `pnpm --filter cartographer exec tsc --noEmit`
Run: `pnpm --filter cartographer exec vitest run src/server/`
Expected: PASS

### Step 4: Commit

```bash
git add packages/cartographer/src/server/api-handlers.ts
git commit -m "refactor(server): update agent introspection to use AgentInfo"
```
