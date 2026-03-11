# Cartographer

A TypeScript behavior tree framework with first-class Claude Agent SDK integration.

Cartographer lets you compose AI agents, deterministic logic, and scheduled automation into behavior trees. It provides classical BT primitives — selectors, sequences, parallel nodes, decorators — alongside an `AgentNode` that delegates subtasks to Claude, giving you fine-grained control over when and how an LLM participates in your program's control flow.

## Features

- **Classical behavior tree nodes** — Sequences, selectors, parallel nodes, and seven decorator types (retry, timeout, guard, inverter, repeat, always-succeed, always-fail).
- **Agent nodes** — Agentic Claude SDK calls with optional `outputSchema` for structured, schema-validated output.
- **Agent strategies** — Swap static child ordering or parallel policies for AI-driven decisions at runtime.
- **Blackboard state management** — Shared key-value store with namespace scoping for inter-node communication.
- **Event-driven observability** — Typed events for node lifecycle, agent calls, blackboard writes, and strategy decisions.
- **Flexible tree construction** — Fluent builder API, YAML configuration with a type registry, or direct node instantiation.
- **Scheduler** — Interval, cron, and one-shot execution with configurable tick behavior.

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
      prompt: (ctx) => `Classify this ticket: ${ctx.blackboard.get<string>("ticket")}`,
      model: "haiku",
      effort: "low",
      outputSchema: z.object({
        category: z.enum(["billing", "technical", "general"]),
        urgency: z.enum(["low", "medium", "high"]),
      }),
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
- [Decorators](docs/guide-decorators.md) — All seven decorator types with examples.
- [Blackboard and Events](docs/guide-blackboard-and-events.md) — State management and observability.
- [Agent Integration](docs/guide-agent-integration.md) — AgentNode configuration, agent strategies, and MCP tools.
- [Scheduler](docs/guide-scheduler.md) — Interval, cron, and one-shot scheduling.
- [API Reference](docs/api/index.md) — Complete API documentation.

## Contributing

### Setup

```bash
git clone https://github.com/marclove/cartographer-ts
cd cartographer
npm install
```

### Development Commands

```bash
npm run build            # Compile TypeScript to dist/
npm run test             # Run unit tests
npm run test:integration # Run integration tests
npm run test:all         # Run all tests (unit + integration)
npm run test:watch       # Watch unit tests
npm run typecheck        # Type-check without emitting
```

To run a single test file:

```bash
npx vitest run src/nodes/action.test.ts
```

### Project Structure

```
src/
  nodes/         # Leaf nodes: ActionNode, ConditionNode, AgentNode
  composites/    # SequenceNode, SelectorNode, ParallelNode
  decorators/    # Inverter, Repeat, Retry, Timeout, Guard, AlwaysSucceed, AlwaysFail
  strategies/    # Default and agent-backed strategies for composites
  builder/       # Fluent TreeBuilder API
  config/        # TreeRegistry + TreeLoader (YAML config)
  scheduler/     # TreeScheduler (interval, cron, one-shot)
  agent/         # Blackboard MCP server and SDK helpers
  core/          # BehaviorTree, MapBlackboard, EventEmitter
  types.ts       # All shared types
  index.ts       # Public API re-exports
```

### Testing

Unit tests live alongside their source files (`src/**/*.test.ts`). Integration tests live in `src/__integration__/` and are split into two categories:

- **Deterministic tests** — Exercise multi-component workflows (retry + timeout + sequence, scheduler resumption, config-driven trees, etc.) and always run.
- **Agent SDK tests** — Make real Claude API calls and require an `ANTHROPIC_API_KEY` environment variable. They are automatically skipped when the key is not set.

```bash
# Run agent SDK integration tests
ANTHROPIC_API_KEY=sk-... npm run test:integration
```

### Tech Stack

- TypeScript (ES2022, ESM-only)
- [Vitest](https://vitest.dev/) for testing
- [Zod](https://zod.dev/) v4 for schema validation
- [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) for AI integration

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
