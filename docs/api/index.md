# API Reference

Cartographer exports all public types and classes from the package root. Every symbol listed below is available as a named import:

```ts
import { BehaviorTree, ActionNode, NodeStatus } from "cartographer";
```

---

## Enum

| Export       | Description                     |
| ------------ | ------------------------------- |
| `NodeStatus` | `SUCCESS`, `FAILURE`, `RUNNING` |

## Types

Re-exported from the internal type definitions. See individual reference pages for full signatures.

| Export                | Description                                          |
| --------------------- | ---------------------------------------------------- |
| `BTreeNode`           | Base node interface                                  |
| `TreeContext`         | Per-tick context passed through the tree             |
| `Blackboard`          | Shared key-value state interface                     |
| `TreeEvents`          | Event map for tree lifecycle events                  |
| `TypedEventEmitter`   | Generic typed event emitter interface                |
| `SelectionStrategy`   | Strategy for child selection in composites           |
| `ExecutionStrategy`   | Strategy for child execution in composites           |
| `ParallelPolicy`      | Success/failure thresholds for parallel nodes        |
| `ParallelStrategy`    | Strategy for parallel child execution                |
| `AgentStrategyConfig` | Configuration for agent-aware strategies             |
| `ActionNodeConfig`    | Configuration for `ActionNode`                       |
| `ConditionNodeConfig` | Configuration for `ConditionNode`                    |
| `AgentNodeConfig`     | Configuration for `AgentNode`                        |
| `SelectorConfig`      | Configuration for `SelectorNode`                     |
| `SequenceConfig`      | Configuration for `SequenceNode`                     |
| `ParallelConfig`      | Configuration for `ParallelNode`                     |
| `DecoratorConfig`     | Base configuration for decorator nodes               |
| `RepeatConfig`        | Configuration for `RepeatNode`                       |
| `RetryConfig`         | Configuration for `RetryNode`                        |
| `TimeoutConfig`       | Configuration for `TimeoutNode`                      |
| `GuardConfig`         | Configuration for `GuardNode`                        |
| `BehaviorTreeConfig`  | Top-level tree configuration                         |
| `SchedulerConfig`     | Configuration for `TreeScheduler`                    |
| `SchedulerEvents`     | Event map for scheduler lifecycle events             |
| `TreeLoggerOptions`   | Configuration for `createTreeLogger`                 |
| `RunContext`          | Context provided to CLI tree factory functions       |
| `TreeRunConfig`       | Configuration returned by CLI tree factory functions |
| `FormatterOptions`    | Configuration for CLI output formatter               |

## [Core](core.md)

| Export               | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `BehaviorTree`       | Tree runner — builds, ticks, and manages a behavior tree |
| `InMemoryBlackboard` | Default `Blackboard` implementation backed by a `Map`    |
| `EventEmitter`       | Typed event emitter used throughout the library          |

## [Leaf Nodes](nodes.md)

| Export          | Description                                         |
| --------------- | --------------------------------------------------- |
| `BaseNode`      | Abstract base class for authoring custom nodes      |
| `ActionNode`    | Execute arbitrary synchronous or asynchronous logic |
| `ConditionNode` | Boolean check that returns `SUCCESS` or `FAILURE`   |
| `AgentNode`     | Claude Agent SDK integration node                   |

## [Composites](composites.md)

| Export         | Description                                              |
| -------------- | -------------------------------------------------------- |
| `SelectorNode` | Try children until one succeeds                          |
| `SequenceNode` | Run all children in order; fail on first failure         |
| `ParallelNode` | Run all children concurrently with configurable policies |

## [Decorators](decorators.md)

| Export              | Description                                        |
| ------------------- | -------------------------------------------------- |
| `InverterNode`      | Inverts the child result (`SUCCESS` <-> `FAILURE`) |
| `RepeatNode`        | Repeats the child a fixed number of times          |
| `RetryNode`         | Retries the child on failure up to a limit         |
| `AlwaysSucceedNode` | Wraps the child and always returns `SUCCESS`       |
| `AlwaysFailNode`    | Wraps the child and always returns `FAILURE`       |
| `TimeoutNode`       | Fails the child if it exceeds a time limit         |
| `GuardNode`         | Gates execution behind a condition                 |

## [Strategies](strategies.md)

| Export                     | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `DefaultSelectionStrategy` | Standard left-to-right child selection               |
| `DefaultExecutionStrategy` | Standard sequential child execution                  |
| `DefaultParallelStrategy`  | Standard concurrent execution with policy evaluation |
| `AgentSelectionStrategy`   | Agent-aware child selection                          |
| `AgentExecutionStrategy`   | Agent-aware child execution                          |
| `AgentParallelStrategy`    | Agent-aware parallel execution                       |

## [Builder](builder.md)

| Export               | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `TreeBuilder`        | Fluent API entry point for constructing trees                      |
| `CompositeBuilder`   | Builder context for composite nodes (selector, sequence, parallel) |
| `SingleChildBuilder` | Builder context for decorator nodes                                |

## [Config](config.md)

| Export         | Description                                                       |
| -------------- | ----------------------------------------------------------------- |
| `TreeRegistry` | Registry of named node factories for declarative tree definitions |
| `TreeLoader`   | Loads a tree from a YAML string or config object using a registry |

## [Scheduler](scheduler.md)

| Export          | Description                                                  |
| --------------- | ------------------------------------------------------------ |
| `TreeScheduler` | Runs a behavior tree on a schedule (interval, cron, or once) |

## Agent Integration

| Export                         | Description                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createBlackboardMcpServer`    | Creates an MCP server that exposes the blackboard to Claude agents. See [Agent Integration guide](../guide-agent-integration.md) for usage.                                                                   |
| `emitMessageEvents`            | Emits granular `agent:*` observability events for a raw SDK message. Used internally by `AgentNode` and agent strategies; available for custom strategy implementations.                                      |
| `createStrategyMessageHandler` | Creates a message handler for strategy SDK calls that emits per-message observability events plus `agent:response`/`agent:error` lifecycle events. Intended as the `onMessage` callback to `queryStructured`. |

## Logging

| Export              | Description                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createTreeLogger`  | Attaches to a tree's event emitter and appends structured NDJSON log entries to a file. See [Structured Logging](../guide-blackboard-and-events.md#structured-logging-with-createtreelogger). |
| `TreeLoggerOptions` | Configuration type for `createTreeLogger`.                                                                                                                                                    |

## [CLI](cli.md)

| Export             | Description                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `RunContext`       | Context provided by the CLI to tree factory functions (env vars + positional args).            |
| `TreeRunConfig`    | Configuration returned by factory functions (tree, schedule, stopping conditions).             |
| `FormatterOptions` | Options for `createFormatter` (json, verbose, quiet modes).                                    |
| `createFormatter`  | Subscribes to tree events and renders structured output to stdout. Returns a cleanup function. |
