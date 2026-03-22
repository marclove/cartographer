# Task 150: Update Builder API

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update the builder's `agent()` method to accept the new `AgentNodeConfig` shape (with `agent: Agent` instead of `options`).

**Architecture:** The `CompositeBuilder.agent()` and `SingleChildBuilder.agent()` methods already take `Omit<AgentNodeConfig, 'name'>` — since `AgentNodeConfig` was updated in task 147, the builder signatures automatically reflect the change. This task updates the builder tests and JSDoc examples to match.

**Tech Stack:** TypeScript

**Spec:** `docs/superpowers/specs/2026-03-22-extract-agent-definition-design.md` — see "Builder API" section.

**Dependencies:** Task 147 (updated config types), Task 148 (refactored AgentNode)

---

### Step 1: Update builder tests

Modify `packages/cartographer/src/builder/tree-builder.test.ts`:

Find all test cases that use `b.agent('name', { prompt: '...' })` or similar patterns. Update them to include `agent: testAgent` in the config. Create a minimal `TestAgent` for the builder tests (or import from a shared test utility).

Key tests to update:
- `agent() inside a composite` — add `agent` field
- `agent() inside a decorator` — add `agent` field
- Any test that constructs an `AgentNode` through the builder

### Step 2: Run tests to verify they fail

Run: `pnpm --filter cartographer exec vitest run src/builder/tree-builder.test.ts`
Expected: FAIL — tests pass `options` instead of `agent`

### Step 3: Update builder JSDoc examples

Modify `packages/cartographer/src/builder/tree-builder.ts`:

Update the JSDoc examples in the class documentation and method documentation that show `b.agent('name', { prompt: '...', options: { ... } })` to use the new pattern:

```typescript
// Before (in JSDoc)
b.agent('confirm', {
  prompt: 'Generate a brief order confirmation message',
});

// After (in JSDoc)
b.agent('confirm', {
  agent: confirmAgent,
  prompt: 'Generate a brief order confirmation message',
});
```

The method signatures themselves (`agent(name: string, config: Omit<AgentNodeConfig, 'name'>)`) don't change — they already reference `AgentNodeConfig` which was updated in task 147.

### Step 4: Run tests to verify they pass

Run: `pnpm --filter cartographer exec vitest run src/builder/tree-builder.test.ts`
Expected: PASS

### Step 5: Commit

```bash
git add packages/cartographer/src/builder/tree-builder.ts packages/cartographer/src/builder/tree-builder.test.ts
git commit -m "refactor(builder): update agent() examples and tests for Agent-based config"
```
