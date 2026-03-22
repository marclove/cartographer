# Task 152: Update Public Exports and Clean Up SDK Helpers

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update `src/index.ts` to export new types (`Agent`, `ClaudeSDKAgent`, `AgentMessage`, etc.), remove deleted exports (`emitMessageEvents`, `queryStructured`, `createStrategyMessageHandler`), and clean up `sdk-helpers.ts` by removing functions that moved to `ClaudeSDKAgent`.

**Architecture:** `sdk-helpers.ts` retains `wrapElicitation` and `buildStrategyPrompt` (still used by strategies and potentially by provider implementations). `emitMessageEvents`, `queryStructured`, and `createStrategyMessageHandler` are removed from the file — their logic now lives in `ClaudeSDKAgent`.

**Tech Stack:** TypeScript

**Spec:** `docs/superpowers/specs/2026-03-22-extract-agent-definition-design.md` — see "Public API" and "File Changes" sections.

**Dependencies:** Task 146 (ClaudeSDKAgent), Task 148 (refactored AgentNode), Task 149 (refactored strategies)

---

### Step 1: Clean up sdk-helpers.ts

Modify `packages/cartographer/src/agent/sdk-helpers.ts`:

Remove the following functions (their logic has moved into `ClaudeSDKAgent`):
- `emitMessageEvents` (lines ~174-229)
- `queryStructured` (lines ~101-164)
- `createStrategyMessageHandler` (lines ~238-275)

Keep:
- `wrapElicitation` — cross-provider utility, used by `ClaudeSDKAgent` and potentially future providers
- `buildStrategyPrompt` — strategy logic, used by all three agent strategies

Remove any imports that are only used by the deleted functions.

### Step 2: Update sdk-helpers tests

Modify `packages/cartographer/src/agent/sdk-helpers.test.ts`:

Remove tests for `emitMessageEvents`, `queryStructured`, and `createStrategyMessageHandler`. Keep tests for `wrapElicitation` and `buildStrategyPrompt`.

### Step 3: Run helper tests

Run: `pnpm --filter cartographer exec vitest run src/agent/sdk-helpers.test.ts`
Expected: PASS

### Step 4: Update src/index.ts exports

Modify `packages/cartographer/src/index.ts`:

Add new exports:
```typescript
export { Agent } from './agent/agent.js';
export type { AgentConfig, AgentSendOptions, AgentMessage, AgentInfo, AgentUsage } from './agent/agent.js';
export { ClaudeSDKAgent } from './agent/claude-sdk-agent.js';
export type { ClaudeSDKAgentConfig } from './agent/claude-sdk-agent.js';
```

Remove deleted exports:
```typescript
// Remove these lines:
export { emitMessageEvents, createStrategyMessageHandler, ... } from './agent/sdk-helpers.js';
```

Keep existing exports:
```typescript
export { wrapElicitation } from './agent/sdk-helpers.js';
export { buildStrategyPrompt } from './agent/sdk-helpers.js';
export { createBlackboardMcpServer } from './agent/blackboard-mcp.js';
```

### Step 5: Verify typecheck passes

Run: `pnpm --filter cartographer exec tsc --noEmit`
Expected: PASS (no type errors)

### Step 6: Commit

```bash
git add packages/cartographer/src/index.ts packages/cartographer/src/agent/sdk-helpers.ts packages/cartographer/src/agent/sdk-helpers.test.ts
git commit -m "refactor: update public exports, remove moved SDK helper functions"
```
