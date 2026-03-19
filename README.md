# Cartographer

A TypeScript behavior tree framework with first-class Claude Agent SDK integration.

Cartographer lets you compose AI agents, deterministic logic, and scheduled automation into behavior trees. It provides classical BT primitives — selectors, sequences, parallel nodes, decorators — alongside an `AgentNode` that delegates subtasks to Claude, giving you fine-grained control over when and how an LLM participates in your program's control flow.

Cartographer also includes an **actor framework** that turns behavior trees into persistent, message-driven applications with HTTP endpoints, SSE event delivery, state serialization, and a client SDK for browser and Node.js.

## Features

- **Classical behavior tree nodes** — Sequences, selectors, parallel nodes, and eight decorator types (retry, timeout, guard, inverter, repeat, always-succeed, always-fail, until-success).
- **Agent nodes** — Agentic Claude SDK calls with optional `outputFormat` for structured, schema-validated output.
- **Agent strategies** — Swap static child ordering or parallel policies for AI-driven decisions at runtime.
- **Blackboard state management** — Shared key-value store with namespace scoping for inter-node communication.
- **Event-driven observability** — Typed events for node lifecycle, agent calls, blackboard writes, strategy decisions, and structured NDJSON logging.
- **Flexible tree construction** — Fluent builder API, YAML configuration with a type registry, or direct node instantiation.
- **Scheduler** — Interval, cron, and one-shot execution with configurable tick behavior.
- **Actor framework** — `TreeActor` and `ActorServer` for persistent, message-driven applications with REST endpoints, SSE events, and state serialization (in-memory or Redis).
- **Client SDK** — `@cartographer/client` for connecting browser and Node.js frontends to a running ActorServer.
- **React and Svelte bindings** — `@cartographer/react` hooks and `@cartographer/svelte` runes for reactive UI integration.
- **CLI runner** — `cartographer run`, `inspect`, and `init` commands for running, visualizing, and scaffolding trees from the command line.
- **Elicitation handling** — MCP server input requests supported at tree, subtree, and node levels with clear precedence rules.
- **Context layering** — Per-subtree overrides of `TreeContext` fields (blackboard, events, elicitation handlers).

## Quick Start

### Prerequisites

- Node.js 18 or later
- An Anthropic API key (only required for agent features)

### Installation

```bash
npm install cartographer
```

### Your First Tree

```typescript
import { TreeBuilder, NodeStatus } from "cartographer";

const tree = new TreeBuilder("hello-tree")
  .sequence("main", (b) => {
    b.action("write-greeting", (ctx) => {
      ctx.blackboard.set("greeting", "Hello, Cartographer!");
      return NodeStatus.SUCCESS;
    });
    b.action("read-greeting", (ctx) => {
      console.log(ctx.blackboard.get<string>("greeting"));
      return NodeStatus.SUCCESS;
    });
  })
  .build();

const { status, blackboard } = await tree.run();
// status: 'success'
// blackboard: { greeting: 'Hello, Cartographer!' }
```

### Adding an Agent Node

```typescript
import { TreeBuilder, NodeStatus } from "cartographer";
import { z } from "zod/v4";

const tree = new TreeBuilder("classifier")
  .sequence("main", (b) => {
    b.agent("classify", {
      prompt: (ctx) =>
        `Classify this ticket: ${ctx.blackboard.get<string>("ticket")}`,
      options: {
        model: "claude-haiku-4-5-20251001",
        effort: "low",
        outputFormat: {
          type: "json_schema",
          schema: z.toJSONSchema(
            z.object({
              category: z.enum(["billing", "technical", "general"]),
              urgency: z.enum(["low", "medium", "high"]),
            }),
          ) as any,
        },
      },
    });
    b.action("log-result", (ctx) => {
      console.log(ctx.blackboard.get("classify:output"));
      return NodeStatus.SUCCESS;
    });
  })
  .build();

const { status } = await tree.run();
```

## Documentation

Full documentation is available in the [`docs/`](docs/) directory:

- [Getting Started](docs/getting-started.md) — Installation and your first tree.
- [Concepts](docs/concepts.md) — Behavior tree fundamentals: ticks, statuses, and the execution model.
- [Building Trees](docs/guide-building-trees.md) — Builder API, YAML configuration, and manual wiring.
- [Nodes](docs/guide-nodes.md) — ActionNode, ConditionNode, and AgentNode.
- [Composites](docs/guide-composites.md) — Selectors, sequences, parallel nodes, and strategies.
- [Decorators](docs/guide-decorators.md) — All eight decorator types with examples.
- [Blackboard and Events](docs/guide-blackboard-and-events.md) — State management, observability, and structured NDJSON logging.
- [Agent Integration](docs/guide-agent-integration.md) — AgentNode modes, agent strategies, and MCP tool configuration.
- [Elicitation](docs/guide-elicitation.md) — Handling MCP server input requests at tree, subtree, and node levels.
- [TreeContext and Context Layering](docs/guide-context.md) — How TreeContext propagates and per-subtree overrides.
- [Scheduler](docs/guide-scheduler.md) — Interval, cron, and one-shot scheduling.
- [CLI Runner](docs/guide-cli.md) — Running, inspecting, and scaffolding trees from the command line.
- [Error Handling and Resilience](docs/guide-error-handling.md) — Error containment, retry/timeout stacking, and abort signals.
- [Testing Behavior Trees](docs/guide-testing.md) — Test contexts, helper functions, and multi-tick test patterns.
- [Advanced Patterns](docs/guide-advanced-patterns.md) — Custom nodes, custom strategies, parallel policies, and advanced YAML.
- [Actor Framework](docs/guide-actor-framework.md) — TreeActor, ActorServer, StateStore, client SDK, and SSE events.
- [Svelte Integration](docs/guide-svelte.md) — Svelte 5 bindings for reactive UI connected to an ActorServer.
- [React Integration](docs/guide-react.md) — React hooks for blackboard, tree status, actions, and events.
- [API Reference](docs/api/index.md) — Complete API documentation.

## Contributing

### Setup

```bash
git clone https://github.com/marclove/cartographer-ts
cd cartographer
pnpm install
```

### Development Commands

```bash
pnpm run build            # Build all packages (via turbo)
pnpm run test             # Run unit tests across all packages
pnpm run test:integration # Run integration tests (cartographer package)
pnpm run test:live        # Run live API tests (requires ANTHROPIC_API_KEY)
pnpm run typecheck        # Type-check all packages
```

To run a single test file:

```bash
pnpm --filter cartographer exec vitest run src/nodes/action.test.ts
```

### Project Structure

```
packages/
  cartographer/    # Core behavior tree framework
  client/          # Browser/Node client SDK (@cartographer/client)
  react/           # React hooks (@cartographer/react)
  svelte/          # Svelte 5 runes (@cartographer/svelte)
apps/
  dashboard/       # Svelte dashboard app (@cartographer/dashboard)
  content-pipeline/   # Example: support ticket triage pipeline
  scheduled-monitor/  # Example: scheduled health monitor
```

### Testing

Unit tests live alongside their source files (`src/**/*.test.ts`). Integration tests live in `src/__integration__/` and are split into two categories:

- **Deterministic tests** — Exercise multi-component workflows (retry + timeout + sequence, scheduler resumption, config-driven trees, etc.) and always run.
- **Agent SDK tests** — Make real Claude API calls and require an `ANTHROPIC_API_KEY` environment variable. They are automatically skipped when the key is not set.

```bash
# Run deterministic integration tests
pnpm run test:integration

# Run live API tests (requires an Anthropic API key)
ANTHROPIC_API_KEY=sk-... pnpm run test:live
```

### Tech Stack

- TypeScript (ES2022, ESM-only)
- [Vitest](https://vitest.dev/) for testing
- [Zod](https://zod.dev/) v4 for schema validation
- [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) for AI integration

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
