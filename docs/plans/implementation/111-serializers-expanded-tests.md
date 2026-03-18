# Task 111: Serializers Expanded Tests — `src/server/serializers.ts` (63% -> ~95%)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add test cases for all uncovered `serializeEvent` branches and edge cases.

**Depends on:** None

---

### Context

`src/server/serializers.ts` has 12 existing tests covering `getNodeType`, `serializeNodeRef`, `serializeTree`, and a few `serializeEvent` event types (`node:enter`, `node:exit`, `agent:thinking`, `tree:tick`, `blackboard:keys/read/write`). Many `serializeEvent` branches for agent events, strategy events, and error events are uncovered.

### Files

- Modify: `src/server/serializers.test.ts`
- Reference: `src/server/serializers.ts` (source under test)
- Reference: `src/types.ts` (event type definitions)

### Approach

No mocking needed — construct real node instances and pass event data objects directly. Follow the existing pattern in `serializers.test.ts`.

---

- [ ] **Step 1: Add agent event serialization tests**

Read `src/server/serializers.ts` to identify all `serializeEvent` branches. Add tests for each uncovered agent event type:

- `agent:text` — returns `{ nodeId, text }`
- `agent:tool_use` — returns `{ nodeId, tool, input }`
- `agent:response` — returns `{ nodeId, result, cost, modelUsage }`
- `agent:error` — returns `{ nodeId, subtype, errors }`
- `agent:message` — returns `{ nodeId, message }`
- `agent:init` — returns `{ nodeId, sessionId, model, tools, mcpServers }`
- `agent:status` — returns `{ nodeId, status }`
- `agent:rate_limit` — returns `{ nodeId, info }`
- `agent:stream` — returns `{ nodeId, event }`
- `agent:elicitation_declined` — returns `{ nodeId, request }`
- `agent:prompt` — returns `{ nodeId, prompt }`

- [ ] **Step 2: Add remaining event type tests**

- `node:error` — extracts `error.message`, returns `{ node, error }`
- `strategy:decision` — returns `{ compositeId, strategy, decision }`
- `tree:tick:skipped` — returns `{ timestamp }` or pass-through

- [ ] **Step 3: Add edge case tests**

- `getNodeType` returns `'unknown'` for an unrecognized node type (construct a plain object satisfying `BTreeNode` interface)
- Unknown/unhandled event type falls through to spread pass-through

- [ ] **Step 4: Run tests and verify coverage**

```bash
npx vitest run src/server/serializers.test.ts
npx vitest run --config vitest.coverage.ts 2>&1 | grep "serializers"
```

Expected: `src/server/serializers.ts` coverage rises to ~95%.
