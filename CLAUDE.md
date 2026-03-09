# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Cartographer** is a TypeScript behavior tree framework with first-class Claude Agent SDK integration. It composes AI agents, deterministic logic, and scheduled automation into behavior trees. ESM-only, Node >= 18.

## Commands

```bash
npm run build            # Compile TypeScript to dist/
npm run test             # Run unit tests (vitest run --project unit)
npm run test:integration # Run integration tests (vitest run --project integration)
npm run test:all         # Run all tests (unit + integration)
npm run test:watch       # Watch unit tests
npm run typecheck        # Type-check without emitting
npx vitest run src/nodes/action.test.ts  # Run a single test file
```

Integration tests in `src/__integration__/` are separated into deterministic tests (always run) and Agent SDK tests (require `ANTHROPIC_API_KEY`).

## Architecture

All types live in `src/types.ts`. Everything is re-exported from `src/index.ts`.

### Node Model

Every node implements the `BTreeNode` interface (`tick`, `reset`, `abort`). Ticks return `NodeStatus` (SUCCESS, FAILURE, RUNNING). A `TreeContext` flows through the tree carrying `blackboard`, `events`, and an optional `AbortSignal`.

### Source Layout

- **`src/nodes/`** — Leaf nodes: `ActionNode` (runs a function), `ConditionNode` (boolean check), `AgentNode` (Claude SDK calls in structured or agentic mode)
- **`src/composites/`** — `SequenceNode` (all succeed), `SelectorNode` (first success), `ParallelNode` (concurrent with policy). Sequence and Selector resume from RUNNING children on subsequent ticks.
- **`src/decorators/`** — Single-child wrappers: Inverter, Repeat, Retry, Timeout, Guard, AlwaysSucceed, AlwaysFail
- **`src/strategies/`** — Strategy pattern for composites. Default strategies pass through; Agent strategies delegate ordering/policy decisions to Claude.
- **`src/builder/`** — Fluent `TreeBuilder` API for constructing trees
- **`src/config/`** — `TreeRegistry` (action/condition registry) + `TreeLoader` (YAML config to tree instances)
- **`src/scheduler/`** — `TreeScheduler` for cron, interval, and one-shot execution
- **`src/agent/`** — `createBlackboardMcpServer` (exposes blackboard to Claude via MCP tools), SDK helpers for agent strategies
- **`src/core/`** — `BehaviorTree` (root runner), `MapBlackboard`/`ScopedBlackboard`, `EventEmitter`

### Key Patterns

- **Strategy injection**: Composites accept optional strategy objects to customize child ordering or parallel success policies. Agent strategies use Claude to make these decisions at runtime.
- **Blackboard scoping**: `ScopedBlackboard` namespaces keys with `:` separator. `AgentNode` can auto-scope via `blackboardNamespace`.
- **Agent caching**: AgentNode and agent strategies support `cache: true` to preserve results across ticks (cleared on `reset()`).
- **Test contexts**: Tests create a `TreeContext` with `new MapBlackboard()` and `new EventEmitter<TreeEvents>()`.

### Dependencies

- `@anthropic-ai/claude-agent-sdk` — Claude integration for AgentNode and agent strategies
- `zod` (v4) — Schema validation for structured agent output
- `yaml` — YAML config loading
- `cron-parser` — Cron expression parsing for scheduler
