# Agent Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add named, shared sessions that allow multiple agent definitions to participate in the same conversation history within a single tree run.

**Architecture:** New `SessionRegistry` on `TreeContext` maps session names to provider session IDs. `AgentNode` resolves session config before calling `agent.send()` and registers returned session IDs. `ClaudeSDKAgent` is refactored from long-lived-query to query-per-send, with each `send()` creating a fresh SDK `query()` that resumes/forks sessions via the SDK's session API. Sessions reset when the tree reaches terminal status.

**Tech Stack:** TypeScript, Vitest, Claude Agent SDK (`@anthropic-ai/claude-code`), `query()` / `resume` / `forkSession` APIs.

**Spec:** `docs/superpowers/specs/2026-03-23-agent-sessions-design.md`

---

## File Structure

### New files
- `packages/cartographer/src/core/session-registry.ts` — SessionRegistry class
- `packages/cartographer/src/core/session-registry.test.ts` — SessionRegistry tests
- `packages/cartographer/src/core/session-validation.ts` — Parallel session concurrency validation
- `packages/cartographer/src/core/session-validation.test.ts` — Validation tests

### Modified files
- `packages/cartographer/src/agent/agent.ts` — AgentSessionOptions, session_start message type, session on AgentSendOptions
- `packages/cartographer/src/agent/test-agent.ts` — Emit session_start, support session options
- `packages/cartographer/src/agent/claude-sdk-agent.ts` — Query-per-send refactor, session support
- `packages/cartographer/src/agent/claude-sdk-agent.test.ts` — Updated tests for query-per-send
- `packages/cartographer/src/nodes/agent.ts` — Session resolution, session_start capture, emitAgentEvent update
- `packages/cartographer/src/nodes/agent.test.ts` — Session integration tests
- `packages/cartographer/src/types.ts` — SessionConfig, sessions on TreeContext, session on AgentNodeConfig, session on BehaviorTreeConfig
- `packages/cartographer/src/core/behavior-tree.ts` — SessionRegistry lifecycle, validation wiring
- `packages/cartographer/src/core/behavior-tree.test.ts` — Session lifecycle tests
- `packages/cartographer/src/actor/tree-actor.ts` — Serialize/restore sessions
- `packages/cartographer/src/state/state-store.ts` — sessions? on TreeSessionState

### Removed files
- `packages/cartographer/src/agent/async-queue.ts` — No longer needed after query-per-send refactor
- `packages/cartographer/src/agent/async-queue.test.ts` — Associated tests

---

## Tasks

| # | Task | Dependencies | File |
|---|---|---|---|
| 154 | SessionRegistry | — | `docs/plans/implementation/154-session-registry.md` |
| 155 | Agent session types + TestAgent | — | `docs/plans/implementation/155-agent-session-types.md` |
| 156 | BehaviorTree session lifecycle | 154 | `docs/plans/implementation/156-behavior-tree-sessions.md` |
| 157 | AgentNode session resolution | 154, 155, 156 | `docs/plans/implementation/157-agent-node-sessions.md` |
| 158 | Session validation | 156, 157 | `docs/plans/implementation/158-session-validation.md` |
| 159 | TreeActor session serialization | 156 | `docs/plans/implementation/159-tree-actor-sessions.md` |
| 160 | ClaudeSDKAgent query-per-send | 155 | `docs/plans/implementation/160-claude-sdk-agent-refactor.md` |
| 161 | Exports + integration verification | 154–160 | `docs/plans/implementation/161-session-exports-cleanup.md` |
