# Task 149: Refactor Agent Strategies to Use Agent.send()

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate `AgentSelectionStrategy`, `AgentExecutionStrategy`, and `AgentParallelStrategy` from calling `queryStructured()` directly to using `agent.send()` with `outputSchema`.

**Architecture:** Each strategy replaces its `queryStructured()` call with `agent.send()`, passing `outputSchema: z.toJSONSchema(schema)` and `onMessage` for event emission. The `createStrategyMessageHandler` helper is no longer needed. `buildStrategyPrompt()` remains unchanged.

**Tech Stack:** TypeScript, Zod (for `z.toJSONSchema()`)

**Spec:** `docs/superpowers/specs/2026-03-22-extract-agent-definition-design.md` — see "Strategy Changes" section.

**Dependencies:** Task 145 (Agent abstract class), Task 147 (updated config types)

---

### Step 1: Update strategy tests

Modify `packages/cartographer/src/strategies/agent-strategies.test.ts`:

Key changes:
- Remove mocking of `queryStructured` from `sdk-helpers`
- Create a `TestAgent` that extends `Agent` and returns controlled `AgentMessage` sequences from `send()` with `outputSchema` support
- Update all test cases to construct strategies with `agent: testAgent` instead of `options: { ... }`
- Keep all existing test semantics: reordering, caching, signal passing, event emission, dynamic prompts

### Step 2: Run tests to verify they fail

Run: `pnpm --filter cartographer exec vitest run src/strategies/agent-strategies.test.ts`
Expected: FAIL — strategies still expect `options` in config

### Step 3: Refactor all three strategies

Modify `packages/cartographer/src/strategies/agent-selection.ts`:

1. Remove imports of `queryStructured`, `createStrategyMessageHandler` from `sdk-helpers`
2. Add import of `Agent` type and `AgentMessage` from `../agent/agent.js`
3. Replace the `queryStructured()` call with:
```typescript
let result: Ordering | null = null;
for await (const msg of this.config.agent.send(prompt, {
  signal: context.signal,
  onMessage: (msg) => { /* emit agent events */ },
  outputSchema: z.toJSONSchema(OrderingSchema),
})) {
  if (msg.type === 'result' && msg.subtype === 'success') {
    result = msg.output as z.infer<typeof OrderingSchema>;
  }
}
```
4. Keep `buildStrategyPrompt()` usage unchanged
5. Keep caching logic unchanged
6. Keep `strategy:decision` event emission unchanged

Apply the same changes to:
- `packages/cartographer/src/strategies/agent-execution.ts`
- `packages/cartographer/src/strategies/agent-parallel.ts`

### Step 4: Run tests to verify they pass

Run: `pnpm --filter cartographer exec vitest run src/strategies/agent-strategies.test.ts`
Expected: PASS

### Step 5: Commit

```bash
git add packages/cartographer/src/strategies/agent-selection.ts packages/cartographer/src/strategies/agent-execution.ts packages/cartographer/src/strategies/agent-parallel.ts packages/cartographer/src/strategies/agent-strategies.test.ts
git commit -m "refactor(strategies): migrate from queryStructured to agent.send() with outputSchema"
```
