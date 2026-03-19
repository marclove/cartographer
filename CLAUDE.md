# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Cartographer** is a TypeScript behavior tree framework with first-class Claude Agent SDK integration. It composes AI agents, deterministic logic, and scheduled automation into behavior trees. ESM-only, Node >= 18.

## Commands

```bash
pnpm run build              # Build all packages (via turbo)
pnpm run test               # Run unit tests across all packages (via turbo)
pnpm run typecheck           # Type-check all packages (via turbo)
pnpm run test:integration    # Run integration tests (cartographer package)
pnpm run test:live           # Run live API tests (requires ANTHROPIC_API_KEY)

# Per-package commands
pnpm --filter cartographer test              # Run cartographer unit tests
pnpm --filter @cartographer/client test      # Run client tests
pnpm --filter @cartographer/react test       # Run react tests
pnpm --filter @cartographer/dashboard test   # Run dashboard tests
```

This is a pnpm + Turborepo monorepo. Tests are organized per-package with each package having its own `vitest.config.ts`. The cartographer package additionally has `vitest.integration.config.ts` and `vitest.live.config.ts` for integration and live API tests.

## Architecture

The repo is a pnpm workspaces monorepo with Turborepo orchestration:

- **`packages/cartographer/`** — Core behavior tree framework (published as `cartographer`)
- **`packages/client/`** — Lightweight browser/Node client SDK (`@cartographer/client`)
- **`packages/react/`** — React hooks (`@cartographer/react`)
- **`apps/dashboard/`** — Svelte dashboard app (`@cartographer/dashboard`)
- **`apps/content-pipeline/`** — Example app
- **`apps/scheduled-monitor/`** — Example app

All core types live in `packages/cartographer/src/types.ts`. Everything is re-exported from `packages/cartographer/src/index.ts`.

### Node Model

Every node implements the `BTreeNode` interface (`tick`, `reset`, `abort`). Ticks return `NodeStatus` (SUCCESS, FAILURE, RUNNING). A `TreeContext` flows through the tree carrying `blackboard`, `events`, and an optional `AbortSignal`.

### Source Layout

- **`src/nodes/`** — Leaf nodes: `ActionNode` (runs a function), `ConditionNode` (boolean check), `AgentNode` (agentic Claude SDK calls, with optional `outputSchema` for structured output)
- **`src/composites/`** — `SequenceNode` (all succeed), `SelectorNode` (first success), `ParallelNode` (concurrent with policy). Sequence and Selector resume from RUNNING children on subsequent ticks.
- **`src/decorators/`** — Single-child wrappers: Inverter, Repeat, Retry, Timeout, Guard, AlwaysSucceed, AlwaysFail
- **`src/strategies/`** — Strategy pattern for composites. Default strategies pass through; Agent strategies delegate ordering/policy decisions to Claude.
- **`src/builder/`** — Fluent `TreeBuilder` API for constructing trees
- **`src/config/`** — `TreeRegistry` (action/condition registry) + `TreeLoader` (YAML config to tree instances)
- **`src/scheduler/`** — `TreeScheduler` for cron, interval, and one-shot execution
- **`src/agent/`** — `createBlackboardMcpServer` (exposes blackboard to Claude via MCP tools), SDK helpers for agent strategies
- **`src/core/`** — `BehaviorTree` (root runner), `InMemoryBlackboard`/`ScopedBlackboard`, `EventEmitter`

### Key Patterns

- **Strategy injection**: Composites accept optional strategy objects to customize child ordering or parallel success policies. Agent strategies use Claude to make these decisions at runtime.
- **Blackboard scoping**: `ScopedBlackboard` namespaces keys with `:` separator. `AgentNode` can auto-scope via `blackboardNamespace`.
- **Agent caching**: AgentNode and agent strategies support `cache: true` to preserve results across ticks (cleared on `reset()`).
- **Test contexts**: Tests create a `TreeContext` with `new InMemoryBlackboard()` and `new EventEmitter<TreeEvents>()`.

### Dependencies

- `@anthropic-ai/claude-agent-sdk` — Claude integration for AgentNode and agent strategies
- `zod` (v4) — Schema validation for structured agent output
- `cron-parser` — Cron expression parsing for scheduler
