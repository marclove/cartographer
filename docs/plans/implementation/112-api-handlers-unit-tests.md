# Task 112: API Handlers Unit Tests — `src/server/api-handlers.ts` (62% -> ~95%)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create unit tests for all exported functions in the API handlers module, with focus on AgentNode field extraction and deep tree traversal.

**Depends on:** None

---

### Context

`src/server/api-handlers.ts` exports `handleApiTree`, `handleApiStatus`, `handleApiBlackboard`, `handleApiNode`, and `findNodeById`. These are currently tested indirectly through `actor-server.test.ts` but have gaps in AgentNode-specific field extraction, deep tree search, and error propagation.

### Files

- Create: `src/server/api-handlers.test.ts`
- Reference: `src/server/api-handlers.ts` (source under test — 71 lines)
- Reference: `src/server/http-utils.ts` (jsonResponse, jsonError helpers)
- Reference: `src/nodes/agent.ts` (AgentNode with agentOptions)

### Approach

Import functions directly and call them with mock `ServerResponse` objects. Construct real node trees using `ActionNode`, `SequenceNode`, and `AgentNode`. For AgentNode, mock the SDK at module level (same pattern as `src/strategies/agent-strategies.test.ts`).

---

- [ ] **Step 1: Test `handleApiTree`, `handleApiStatus`, `handleApiBlackboard`**

Create mock `ServerResponse` that captures `writeHead` and `end` calls:

- `handleApiTree` — returns 200 with `{ tree: name, root: serializedTree }`
- `handleApiStatus` — returns 200 with tick/cycle counts, lastStatus, lastDurationMs, uptime
- `handleApiBlackboard` — returns 200 with blackboard record

- [ ] **Step 2: Test `handleApiNode`**

- Returns 404 for unknown node ID
- Returns base serialized ref for ActionNode (id, name, type)
- Returns AgentNode details: model, tools (from allowedTools), mcpServers (from mcpServers keys)
- Returns children array for composite nodes (SequenceNode with 2+ children)
- Handles AgentNode with missing optional fields (no model, no mcpServers)

- [ ] **Step 3: Test `findNodeById`**

- Finds root node by ID
- Finds leaf node 3 levels deep in a nested tree
- Returns undefined for non-existent ID
- Works with composite nodes containing multiple children at each level

- [ ] **Step 4: Run tests and verify coverage**

```bash
npx vitest run src/server/api-handlers.test.ts
npx vitest run --config vitest.coverage.ts 2>&1 | grep "api-handlers"
```

Expected: `src/server/api-handlers.ts` coverage rises to ~95%.
