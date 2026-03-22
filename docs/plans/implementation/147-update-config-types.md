# Task 147: Update AgentNodeConfig and AgentStrategyConfig Types

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update `AgentNodeConfig` to replace `options?: Partial<Options>` with `agent: Agent` and update `AgentStrategyConfig` to replace `options?: Partial<Options>` with `agent: Agent`.

**Architecture:** Modify the existing type definitions in `src/types.ts`. This is a breaking change — all consumers of these types will need updating in subsequent tasks.

**Tech Stack:** TypeScript

**Spec:** `docs/superpowers/specs/2026-03-22-extract-agent-definition-design.md` — see "AgentNode Changes" and "Strategy Changes" sections.

**Dependencies:** Task 145 (Agent abstract class)

---

### Step 1: Write the type changes

Modify `packages/cartographer/src/types.ts`:

**AgentStrategyConfig** (around line 506):

Change:
```typescript
export interface AgentStrategyConfig {
  prompt: string | ((children: BTreeNode[], context: TreeContext) => string);
  childDescriptions?: Record<string, string>;
  cache?: boolean;
  options?: Partial<Options>;
}
```

To:
```typescript
export interface AgentStrategyConfig {
  prompt: string | ((children: BTreeNode[], context: TreeContext) => string);
  childDescriptions?: Record<string, string>;
  cache?: boolean;
  agent: Agent;
}
```

Add the import at the top of the file:
```typescript
import type { Agent } from './agent/agent.js';
```

**AgentNodeConfig** (around line 670):

Change:
```typescript
export interface AgentNodeConfig {
  id?: string;
  name: string;
  prompt: string | ((context: TreeContext) => string);
  mapResult?: (output: unknown, context: TreeContext) => NodeStatus;
  blackboardNamespace?: string;
  cache?: boolean;
  options?: Partial<Options>;
}
```

To:
```typescript
export interface AgentNodeConfig {
  id?: string;
  name: string;
  agent: Agent;
  prompt: string | ((context: TreeContext) => string);
  mapResult?: (output: unknown, context: TreeContext) => NodeStatus;
  blackboardNamespace?: string;
  cache?: boolean;
}
```

Remove the `Options` import from `@anthropic-ai/claude-agent-sdk` if it is no longer used by any other type in this file.

### Step 2: Verify typecheck fails (expected — consumers not yet updated)

Run: `pnpm --filter cartographer exec tsc --noEmit 2>&1 | head -30`
Expected: Type errors in `agent.ts`, `agent-selection.ts`, `agent-execution.ts`, `agent-parallel.ts`, `tree-builder.ts`, tests, and example apps — all still referencing the old `options` field. This is expected; they will be updated in subsequent tasks.

### Step 3: Commit

```bash
git add packages/cartographer/src/types.ts
git commit -m "feat(types): update AgentNodeConfig and AgentStrategyConfig to use Agent"
```
