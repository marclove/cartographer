# Task 153: Update Example Apps and Integration Tests

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update the two example apps (`content-pipeline`, `scheduled-monitor`) and all integration tests to use the new `ClaudeSDKAgent` + `Agent`-based config instead of inline SDK options.

**Architecture:** Each app defines `ClaudeSDKAgent` instances outside the tree and passes them into `b.agent()` calls. Integration tests construct `ClaudeSDKAgent` instances instead of relying on `AgentNode` to call the SDK directly.

**Tech Stack:** TypeScript

**Spec:** `docs/superpowers/specs/2026-03-22-extract-agent-definition-design.md` — see "Builder API" section.

**Dependencies:** All previous tasks (144-152)

---

### Step 1: Update content-pipeline app

Modify `apps/content-pipeline/tree.ts`:

1. Add import: `import { ClaudeSDKAgent } from 'cartographer';`
2. For each `b.agent()` call, extract the SDK options into a `ClaudeSDKAgent` instance:

```typescript
// Before
b.agent('classify', {
  prompt: classifyPrompt,
  options: {
    model: 'claude-haiku-4-5',
    effort: 'low',
    outputFormat: { ... },
  },
});

// After
const classifyAgent = new ClaudeSDKAgent({
  name: 'classify',
  model: 'claude-haiku-4-5',
  effort: 'low',
  outputFormat: { ... },
});

b.agent('classify', {
  agent: classifyAgent,
  prompt: classifyPrompt,
});
```

Apply the same pattern to all agent nodes in the file.

### Step 2: Update scheduled-monitor app

Modify `apps/scheduled-monitor/tree.ts`:

Same pattern as Step 1 — extract inline SDK options into `ClaudeSDKAgent` instances.

### Step 3: Update integration tests

Modify files in `packages/cartographer/src/__integration__/`:

For each test file that constructs `AgentNode` with `options`:
1. Import `ClaudeSDKAgent` (or a test agent)
2. Replace `options: { model: ..., ... }` with `agent: new ClaudeSDKAgent({ name: '...', model: ..., ... })`
3. Keep the same test semantics — the integration tests should validate the same behaviors

Key integration test files to update:
- `agent-strategies.test.ts`
- Any files in `src/__integration__/live/` that construct agent nodes
- `abort-signal.test.ts`, `elicitation.test.ts` if they exist

### Step 4: Run full test suite

Run: `pnpm test`
Run: `pnpm typecheck`
Expected: PASS — all unit tests, integration tests, and typechecks pass

### Step 5: Run build

Run: `pnpm build`
Expected: PASS — all packages build successfully

### Step 6: Commit

```bash
git add apps/content-pipeline/ apps/scheduled-monitor/ packages/cartographer/src/__integration__/
git commit -m "refactor: update example apps and integration tests for Agent-based config"
```
