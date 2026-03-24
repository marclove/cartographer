# Task 148: Refactor AgentNode to Delegate to Agent

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor `AgentNode` to delegate to an `Agent` instance instead of calling the Claude SDK directly. Remove all SDK imports and logic. AgentNode becomes a thin BT wrapper: prompt resolution, event emission, blackboard I/O, `mapResult`, caching, and inflight state management.

**Architecture:** The `_executeSDKCall` method is replaced by `_executeAgentCall` which calls `agent.send()` and iterates the returned `AsyncIterable<AgentMessage>`. The `agentOptions` getter delegates to `agent.getInfo()`.

**Tech Stack:** TypeScript

**Spec:** `docs/superpowers/specs/2026-03-22-extract-agent-definition-design.md` — see "AgentNode Changes" section.

**Dependencies:** Task 145 (Agent abstract class), Task 147 (updated config types)

---

### Step 1: Update tests first

Modify `packages/cartographer/src/nodes/agent.test.ts`:

The existing tests mock `query` from `@anthropic-ai/claude-agent-sdk`. Replace this with a `TestAgent` that extends `Agent` and returns controlled `AgentMessage` sequences from `send()`.

Key changes:
- Remove `vi.mock('@anthropic-ai/claude-agent-sdk')`
- Create a `TestAgent` class (similar to task 145's test helper but with controllable message sequences)
- Update all test cases to construct `AgentNode` with `agent: testAgent` instead of `options: { ... }`
- Update assertions that check SDK-specific behavior to check `AgentMessage`-based behavior
- Keep all existing test semantics: structured output, unstructured output, mapResult, caching, namespace, abort, interrupt, event emission, serialize/restore

### Step 2: Run tests to verify they fail

Run: `pnpm --filter cartographer exec vitest run src/nodes/agent.test.ts`
Expected: FAIL — `AgentNode` still expects `options` in config, not `agent`

### Step 3: Refactor AgentNode

Modify `packages/cartographer/src/nodes/agent.ts`:

1. **Remove SDK imports**: Remove `import { query } from '@anthropic-ai/claude-agent-sdk'`
2. **Remove SDK helpers imports**: Remove `createBlackboardMcpServer`, `emitMessageEvents` imports
3. **Add Agent imports**: `import type { Agent, AgentMessage } from '../agent/agent.js'`
4. **Remove `_executeSDKCall`**: Replace with `_executeAgentCall` per the spec
5. **Remove blackboard MCP server creation**: This is now in `ClaudeSDKAgent`
6. **Remove `$schema` stripping**: This is now in `ClaudeSDKAgent`
7. **Remove `AbortController` bridging**: This is now in `ClaudeSDKAgent`
8. **Remove elicitation resolution**: This is now in `ClaudeSDKAgent`
9. **Remove the `sdkAbortHandlerInstalled` workaround**: This is now in `ClaudeSDKAgent`
10. **Add `emitAgentEvent` private method**: Maps `AgentMessage` to BT `agent:*` events
11. **Update `agentOptions` getter**: Delegate to `this.config.agent.getInfo()`
12. **Update `abort()`/`interrupt()`**: These no longer manage an `activeAbortController` — the signal-based cancellation now flows through `AgentSendOptions`
13. **Remove reserved "blackboard" MCP server name validation from constructor**: Moved to `ClaudeSDKAgent`

The `execute()` method's inflight pattern remains the same — it kicks off `_executeAgentCall` in the background and polls on subsequent ticks.

### Step 4: Run tests to verify they pass

Run: `pnpm --filter cartographer exec vitest run src/nodes/agent.test.ts`
Expected: PASS

### Step 5: Commit

```bash
git add packages/cartographer/src/nodes/agent.ts packages/cartographer/src/nodes/agent.test.ts
git commit -m "refactor(agent-node): delegate to Agent, remove SDK logic"
```
