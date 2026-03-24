# Task 146: ClaudeSDKAgent Implementation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `ClaudeSDKAgent`, the concrete `Agent` wrapping the Claude Agent SDK V1 stable API. Handles SDK query lifecycle, message queue, turn demuxing, blackboard MCP injection, elicitation wrapping, abort/interrupt, error propagation, and session recovery.

**Architecture:** Uses the V1 `AsyncIterable<SDKUserMessage>` prompt pattern for multi-turn. A single long-lived `query()` call is created lazily on first `send()`. The `AsyncQueue` bridges `send()` calls to the SDK. A private demux loop maps SDK messages to `AgentMessage` and routes them to per-turn iterables.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk`, `AsyncQueue` from task 144

**Spec:** `docs/superpowers/specs/2026-03-22-extract-agent-definition-design.md` — see "ClaudeSDKAgent", "Turn Boundaries and Concurrent Sends", and "AsyncQueue Utility" sections.

**Dependencies:** Task 144 (AsyncQueue), Task 145 (Agent abstract class)

**Important:** This is a large task. The test approach uses a mock/stub strategy for the Claude SDK since it spawns a subprocess. Read the existing test patterns in `src/nodes/agent.test.ts` to understand how the SDK is mocked in this codebase before writing tests.

---

### Step 1: Read existing SDK mocking patterns

Read `packages/cartographer/src/nodes/agent.test.ts` to understand how `query` from `@anthropic-ai/claude-agent-sdk` is mocked. The existing tests use `vi.mock` to replace the SDK's `query` function with an async generator that yields controlled messages.

Read `packages/cartographer/src/agent/sdk-helpers.ts` to understand `emitMessageEvents`, `wrapElicitation`, and `createBlackboardMcpServer` — these functions move into or are consumed by `ClaudeSDKAgent`.

### Step 2: Write failing tests

Create `packages/cartographer/src/agent/claude-sdk-agent.test.ts`.

Tests should cover:
1. Constructor validates reserved "blackboard" MCP server name
2. `send()` returns an async iterable that yields `AgentMessage` types
3. SDK messages are correctly mapped to `AgentMessage` (thinking, text, tool_use, result success, result error, provider_event)
4. `onMessage` callback is invoked for each message (and errors in onMessage are swallowed)
5. `outputSchema` sets SDK `outputFormat` option with `$schema` stripping
6. Blackboard MCP server is created and injected when `blackboard` is provided
7. Elicitation handler is wrapped via `wrapElicitation`
8. `sessionId` is null before first send, populated after
9. `getInfo()` returns name, model, allowedTools, mcpServers from config
10. `close()` terminates the query and subsequent `send()` throws
11. Per-turn abort via signal calls `queryInstance.interrupt()`
12. Queued-but-not-started turns are dropped when signal fires before processing

Use `vi.mock('@anthropic-ai/claude-agent-sdk')` to mock the `query` function. Create a helper that returns a controllable async generator.

### Step 3: Implement ClaudeSDKAgent

Create `packages/cartographer/src/agent/claude-sdk-agent.ts`.

Move the following from `src/nodes/agent.ts` and `src/agent/sdk-helpers.ts` into `ClaudeSDKAgent`:
- SDK `query()` invocation with `AsyncIterable<SDKUserMessage>` prompt
- Blackboard MCP server creation via `createBlackboardMcpServer`
- `$schema` stripping from `outputFormat`
- `AbortController` bridging from the `signal` in `AgentSendOptions`
- Elicitation wrapping via `wrapElicitation`
- SDK message → `AgentMessage` mapping (adapted from `emitMessageEvents`)
- The `sdkAbortHandlerInstalled` unhandled rejection workaround

Key implementation details:
- `ClaudeSDKAgentConfig = AgentConfig & Partial<Options>` — flat config
- Lazy query creation on first `send()` — cheap to define an agent
- `send()` returns an `AsyncIterable<AgentMessage>` scoped to one turn
- Internal demux loop: consumes SDK async generator, maps messages, routes to the correct turn's iterable based on queue order
- `onMessage` errors are caught and emitted as `{ type: 'provider_event', subtype: 'onMessage_error', data: error }`
- `interrupt()` for per-turn abort, `close()` for full disposal
- Session recovery: if query dies, next `send()` recreates with `resume: sessionId`

### Step 4: Run tests to verify they pass

Run: `pnpm --filter cartographer exec vitest run src/agent/claude-sdk-agent.test.ts`
Expected: PASS

### Step 5: Commit

```bash
git add packages/cartographer/src/agent/claude-sdk-agent.ts packages/cartographer/src/agent/claude-sdk-agent.test.ts
git commit -m "feat(agent): implement ClaudeSDKAgent with turn demuxing and lifecycle management"
```
