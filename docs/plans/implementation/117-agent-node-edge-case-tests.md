# Task 117: AgentNode Edge Case Tests — `src/nodes/agent.ts` (83% -> ~93%)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add tests for uncovered AgentNode paths: serialization, $schema stripping, structured output fallback, and stream EOF.

**Depends on:** None

---

### Context

`src/nodes/agent.ts` is at 83% coverage with 36 existing tests. The gaps are in serialize/restore for `_lastTerminalStatus`, the `$schema` property stripping from outputFormat schemas, the structured_output fallback chain, and the stream EOF path.

### Files

- Modify: `src/nodes/agent.test.ts`
- Reference: `src/nodes/agent.ts` (source under test)

### Approach

Follow existing pattern in `agent.test.ts` which mocks `@anthropic-ai/claude-agent-sdk` at module level.

---

- [ ] **Step 1: Add serialize/restore tests**

- `serialize()` returns `{ lastStatus: 'success' }` after a terminal tick
- `serialize()` returns `{}` when no terminal status has been recorded
- `restore({ lastStatus: 'failure' })` sets internal `_lastTerminalStatus`

- [ ] **Step 2: Add $schema stripping test**

- When `outputFormat.schema` contains a `$schema` property, it is removed before passing to the SDK `query()` call
- Verify the mock SDK receives the schema without `$schema`

- [ ] **Step 3: Add structured output fallback test**

- When `outputFormat` is set but SDK returns no `structured_output` on the result, falls back to JSON-parsing `msg.result`
- When `msg.result` is not valid JSON, falls back to raw string

- [ ] **Step 4: Add stream EOF test**

- When the SDK async iterator yields no messages at all, node returns FAILURE

- [ ] **Step 5: Run tests and verify coverage**

```bash
npx vitest run src/nodes/agent.test.ts
npx vitest run --config vitest.coverage.ts 2>&1 | grep "agent.ts"
```

Expected: `src/nodes/agent.ts` coverage rises to ~93%.
