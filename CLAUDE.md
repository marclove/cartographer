# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cartographer is a TypeScript behavior tree framework that combines deterministic BT execution with Claude Agent SDK integration. It enables building dependable agent systems where AI agents operate within structured, observable control flows.

## Monorepo Structure

pnpm workspaces + Turborepo. All packages use ES modules with Node16 module resolution.

- `packages/cartographer` — Core BT framework (nodes, composites, decorators, strategies, scheduler, actor, server, CLI)
- `packages/client` — Lightweight client SDK for ActorServer (SSE event streaming, REST API)
- `packages/react` — React 19 hooks for behavior trees
- `packages/svelte` — Svelte 5 runes for behavior trees
- `apps/dashboard` — Svelte 5 interactive TUI for tree observation
- `apps/content-pipeline` — Example: content processing workflows
- `apps/scheduled-monitor` — Example: health monitoring and incident management

## Commands

```bash
pnpm build                          # Build all packages (turbo → tsc)
pnpm test                           # Unit tests across all packages
pnpm typecheck                      # Type-check all packages
pnpm test:integration               # Integration tests (cartographer only)
pnpm test:live                      # Live tests with real Claude API calls

# Single package
pnpm --filter cartographer test
pnpm --filter @cartographer/client test

# Single test file
pnpm --filter cartographer exec vitest run src/nodes/action.test.ts

# Watch mode
pnpm --filter cartographer exec vitest src/nodes/action.test.ts
```

Note: cartographer tests require `NODE_OPTIONS=--experimental-eventsource` (already set in package.json scripts).

## Architecture

### Execution Model

Every node implements `tick(context: TreeContext) → Promise<NodeStatus>` returning one of three statuses: `SUCCESS`, `FAILURE`, or `RUNNING`. Composites and decorators use these to drive control flow. RUNNING means the node has in-flight async work and should be ticked again.

### Node Hierarchy

- **Leaf nodes**: ActionNode, ConditionNode, AgentNode, ReceiveNode, EmitToClientNode — do actual work
- **Composites**: SelectorNode (first success wins), SequenceNode (all must succeed), ParallelNode (concurrent with completion policies)
- **Decorators**: InverterNode, RepeatNode, RetryNode, TimeoutNode, GuardNode, AlwaysSucceedNode, AlwaysFailNode, UntilSuccessNode — wrap a single child

### Key Abstractions

- **TreeContext** — Passed to every node during tick. Carries blackboard, event emitter, abort signal, and configuration overrides.
- **Blackboard** — Shared key-value store with `scoped(namespace)` for isolation between nodes. Primary mechanism for inter-node communication.
- **EventEmitter** — Typed observer pattern covering node lifecycle, agent activity, data mutations, tree lifecycle, and strategy decisions.
- **Strategies** — Pluggable policies for selection, execution, and parallel behavior. Default and Agent variants exist.
- **Serialization** — Tree state snapshots with content hashing for hydration across ticks and persistence.

### Higher-Level Constructs

- **TreeScheduler** (`src/scheduler/`) — Interval/cron scheduling with lifecycle hooks
- **MessageProcessor** (`src/actor/`) — Message-driven processor with state serialization for persistent sessions
- **ActorServer** (`src/server/`) — HTTP server with SSE event streaming, REST API, state persistence via StateStore
- **StateStore** (`src/state/`) — Abstract persistence interface with InMemoryStateStore and RedisStateStore implementations

### Agent Integration

AgentNode delegates work to Claude via the Agent SDK. `createBlackboardMcpServer` exposes the blackboard as MCP tools for agent access. Agent strategies (AgentSelectionStrategy, AgentExecutionStrategy, AgentParallelStrategy) provide specialized policies for multi-agent coordination.

## Conventions

- Files: kebab-case. Classes: PascalCase with "Node" suffix for BT nodes. Private members: underscore prefix.
- Imports use explicit `.js` extensions (Node16 module resolution requirement).
- Tests colocated with source as `*.test.ts`. Integration tests in `src/__integration__/`.
- Nodes never throw — errors are converted to FAILURE status with error events emitted.
- All `tick()` methods are async. Multi-tick work returns RUNNING with in-flight state cached via `_inflightState`.
- ID generators (generateRequestId, generateMessageId, generateEventId) are intentionally separate — do not consolidate.
- RedisStateStore.readEvents() AsyncIterable must handle client disconnection teardown explicitly.
