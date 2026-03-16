# Cartographer

**A TypeScript behavior tree framework combining deterministic BT patterns with Claude Agent SDK integration.**

Cartographer (`cartographer`, v0.1.0) lets you compose AI agents, deterministic logic, and scheduled automation into behavior trees that are easy to reason about, test, and extend. It provides classical BT primitives -- selectors, sequences, decorators -- alongside an `AgentNode` that delegates subtasks to Claude, giving you fine-grained control over when and how an LLM participates in your program's control flow.

Cartographer also includes an **actor framework** that turns behavior trees into persistent, message-driven applications with HTTP endpoints, SSE event delivery, state serialization, and a client SDK for browser and Node.js. Requires Node >= 18.

## Example Use Cases

- **Content pipelines** -- Orchestrate multi-step generation, review, and publishing workflows where some steps are deterministic and others require LLM judgment.
- **Interactive applications** -- Build message-driven apps where AI agents and human users collaborate through shared state, using the actor framework with REST, SSE, and a client SDK.
- **Monitoring and alerting** -- Schedule trees on intervals or cron expressions to poll systems, evaluate conditions, and take corrective action.
- **Multi-agent coordination** -- Run several AgentNodes in parallel or sequence, each with its own tools and system prompt, coordinated by composite nodes.
- **Classification and routing** -- Use condition nodes and selectors to route inputs through different processing branches based on structured or LLM-driven evaluation.

The [`examples/`](../examples/) directory contains two runnable programs that exercise these patterns end-to-end with real Claude API calls. See the [Examples README](../examples/README.md) for details.

## Where to Start

Your background determines the fastest path through these docs.

| If you are...                                     | Start here                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **New to behavior trees**                         | Read [Concepts](concepts.md) for BT fundamentals, then [Getting Started](getting-started.md) to build your first tree.                        |
| **Familiar with BTs but new to Claude Agent SDK** | Skim [Getting Started](getting-started.md), then jump to [Agent Integration](guide-agent-integration.md) for AgentNode modes and MCP tooling. |
| **Building a message-driven application?**        | Start with [Actor Framework](guide-actor-framework.md) for TreeActor, ActorServer, StateStore, and the client SDK.                             |
| **Looking for API details**                       | Go directly to the [API Reference](api/index.md).                                                                                             |
| **Want to run trees from the CLI?**               | See the [CLI Runner](guide-cli.md) guide for `cartographer run`, `inspect`, and `init`.                                                       |

## Table of Contents

### Guides

- [Getting Started](getting-started.md) -- Installation and your first tree in 60 seconds.
- [Concepts](concepts.md) -- Behavior tree fundamentals: ticks, statuses, and tree structure.
- [Building Trees](guide-building-trees.md) -- Three construction approaches side-by-side: builder API, declarative config, and manual wiring.
- [Nodes](guide-nodes.md) -- Leaf nodes: ActionNode, ConditionNode, and an introduction to AgentNode.
- [Composites](guide-composites.md) -- SelectorNode, SequenceNode, and ParallelNode with completion strategies.
- [Decorators](guide-decorators.md) -- All eight decorator nodes with examples.
- [Blackboard and Events](guide-blackboard-and-events.md) -- State management with InMemoryBlackboard, observability via the event emitter, and structured NDJSON logging.
- [Agent Integration](guide-agent-integration.md) -- AgentNode modes, agent strategies, and MCP tool configuration.
- [Elicitation](guide-elicitation.md) -- Handling MCP server input requests at tree, subtree, and node levels.
- [TreeContext and Context Layering](guide-context.md) -- How TreeContext propagates through the tree and how to override fields per subtree.
- [Scheduler](guide-scheduler.md) -- TreeScheduler: interval, cron, and one-shot scheduling.
- [CLI Runner](guide-cli.md) -- Running, inspecting, and scaffolding trees from the command line.
- [Error Handling and Resilience](guide-error-handling.md) -- Error containment, retry/timeout stacking, abort signals, and scheduler error recovery.
- [Testing Behavior Trees](guide-testing.md) -- Test contexts, helper functions, event verification, and multi-tick test patterns.
- [Advanced Patterns](guide-advanced-patterns.md) -- Custom nodes, custom strategies, multi-tick resumption internals, parallel policies, advanced blackboard patterns, and advanced YAML.
- [Actor Framework](guide-actor-framework.md) -- TreeActor, ActorServer, StateStore, client SDK, SSE events, serialization, and content hashing.

### Examples

- [Examples README](../examples/README.md) -- Two runnable programs demonstrating the framework end-to-end: a support ticket triage pipeline and a scheduled health monitor with incident management.

### API Reference

- [API Overview](api/index.md) -- Import conventions and module organization.
- [Core](api/core.md) -- `BehaviorTree`, `InMemoryBlackboard`, `EventEmitter`.
- [Nodes](api/nodes.md) -- `BaseNode`, `ActionNode`, `ConditionNode`, `AgentNode`.
- [Composites](api/composites.md) -- `SelectorNode`, `SequenceNode`, `ParallelNode`.
- [Decorators](api/decorators.md) -- All eight decorator nodes.
- [Strategies](api/strategies.md) -- Default and agent strategies, strategy interfaces.
- [Builder](api/builder.md) -- `TreeBuilder`, `CompositeBuilder`, `SingleChildBuilder`.
- [Config](api/config.md) -- `TreeLoader`, `TreeRegistry`.
- [Scheduler](api/scheduler.md) -- `TreeScheduler`, `SchedulerConfig`, `SchedulerEvents`.
- [Actor](api/actor.md) -- `TreeActor`, `ActorServer`, `ActorMessage`, `StateStore`, `InMemoryStateStore`, `RedisStateStore`.
- [Client](api/client.md) -- `createCartographerClient`, `CartographerClient`, `ConflictError`.
- [Serialization](api/serialization.md) -- `serializeTree`, `restoreTree`, `buildHashIndex`, `computeContentHash`.
- [CLI](api/cli.md) -- `RunContext`, `TreeRunConfig`, `FormatterOptions`, `createFormatter`.
