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
| `TickLoopHandle`      | Handle returned by `BehaviorTree.start()`            |
| `TreeLoggerOptions`   | Configuration for `createTreeLogger`                 |
| `RunContext`          | Context provided to CLI tree factory functions       |
| `TreeRunConfig`       | Configuration returned by CLI tree factory functions |
| `FormatterOptions`    | Configuration for CLI output formatter               |
| `AgentConfig`         | Configuration for `Agent` implementations            |
| `AgentSendOptions`    | Per-invocation options for `Agent.send()`            |
| `AgentMessage`        | Discriminated union of agent response messages       |
| `AgentInfo`           | Provider-agnostic agent metadata                     |
| `AgentUsage`          | Token usage information from a completed turn        |
| `AgentSessionOptions` | Session options for `Agent.send()` (resume, fork)    |
| `ClaudeSDKAgentConfig`| Configuration for `ClaudeSDKAgent`                   |
| `SessionConfig`       | Named session participation config for `AgentNode`   |
| `AgentTextMessage`    | Named type for `{ type: 'text' }` agent messages     |
| `AgentToolUseMessage` | Named type for `{ type: 'tool_use' }` agent messages |
| `AgentSuccessResult`  | Named type for successful result messages             |
| `AgentErrorResult`    | Named type for error result messages                  |
| `AgentResultMessage`  | Union of success and error result messages            |
| `AgentSessionStartMessage` | Named type for session start messages            |
| `AgentThinkingMessage`| Named type for thinking/reasoning messages            |
| `AgentStreamMessage`  | Named type for raw streaming events                   |
| `AgentProviderEvent`  | Named type for provider-specific events               |
| `ThinkingCapable`     | Capability interface for agents that produce thinking |
| `StreamCapable`       | Capability interface for agents that produce streams  |
| `OnElicitation`       | Handler type for elicitation requests                 |
| `ElicitationOptions`  | Options passed to elicitation handlers                |
| `AgentElicitationRequest`  | Elicitation request from an MCP server           |
| `AgentElicitationResponse` | Response to an elicitation request               |

## [Core](core.md)

| Export               | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `BehaviorTree`       | Tree runner — builds, ticks, and manages a behavior tree |
| `InMemoryBlackboard` | Default `Blackboard` implementation backed by a `Map`    |
| `EventEmitter`       | Typed event emitter used throughout the library          |
| `SessionRegistry`    | Named session registry for agent conversation sharing    |

## [Leaf Nodes](nodes.md)

| Export           | Description                                                             |
| ---------------- | ----------------------------------------------------------------------- |
| `BaseNode`       | Abstract base class for authoring custom nodes                          |
| `ActionNode`     | Execute arbitrary synchronous or asynchronous logic                     |
| `ConditionNode`  | Boolean check that returns `SUCCESS` or `FAILURE`                       |
| `AgentNode`      | Claude Agent SDK integration node                                       |
| `isReactiveNode` | Helper that determines if a node is reactive (re-ticked vs cached)      |

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
| `TreeRegistry` | Registry of named node factories for use with the builder API     |

## [Scheduler](scheduler.md)

| Export          | Description                                                  |
| --------------- | ------------------------------------------------------------ |
| `TreeScheduler` | Runs a behavior tree on a schedule (interval, cron, or once) |

## [Agent Integration](agent.md)

| Export                         | Description                                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Agent`                        | Interface for all agent implementations. See [Agent Integration guide](../guide-agent-integration.md).                                        |
| `isThinkingCapable`            | Runtime check for `ThinkingCapable` capability.                                                                                               |
| `isStreamCapable`              | Runtime check for `StreamCapable` capability.                                                                                                 |
| `ClaudeSDKAgent`               | Concrete Agent wrapping the Claude Agent SDK.                                                                                                 |
| `createBlackboardMcpServer`    | Creates an MCP server that exposes the blackboard to agents.                                                                                  |
| `wrapElicitation`              | Wraps an optional elicitation handler with auto-decline fallback. Used internally; exported for custom implementations.                        |
| `buildStrategyPrompt`          | Builds the full prompt string for agent strategy calls, including child descriptions and blackboard state.                                     |

## [Application Server](actor.md)

| Export                     | Description                                                              |
| -------------------------- | ------------------------------------------------------------------------ |
| `MessageProcessor`         | Transient per-message processor                                          |
| `MessageProcessorOptions`  | Options for `MessageProcessor` constructor                               |
| `ProcessResult`            | Result of `MessageProcessor.process()`                                   |
| `ActorServer`              | HTTP server wrapping `MessageProcessor` with REST and SSE                |
| `ActorServerOptions`       | Options for `ActorServer` constructor                                    |
| `ObserverServer`           | Read-only HTTP server for observing a live behavior tree                 |
| `ObserverServerOptions`    | Options for `ObserverServer` constructor                                 |
| `createApp`                | Hono app factory for full actor functionality                            |
| `AppOptions`               | Options for `createApp`                                                  |
| `AppHandle`                | Handle returned by `createApp` with app, processing, and lifecycle       |
| `createObserverApp`        | Hono app factory for read-only tree observation                          |
| `ObserverAppOptions`       | Options for `createObserverApp`                                          |
| `ObserverHandle`           | Handle returned by `createObserverApp` with app and close                |
| `EventBridge`              | Bridges tree events to state persistence and SSE delivery                |
| `ActorMessage`             | Union of all message types                                               |
| `TickMessage`              | Tick message type                                                        |
| `CommandMessage`           | Command message type                                                     |
| `WriteMessage`             | Write message type                                                       |
| `SignalMessage`            | Signal message type (stop, reset, abort, resume)                         |
| `MessageQueuedEvent`       | Event emitted when a message is enqueued                                 |
| `MessageDequeuedEvent`     | Event emitted when a queued message begins processing                    |
| `MessageProcessedEvent`    | Event emitted on message completion                                      |
| `MessageInterruptedEvent`  | Event emitted when a message is interrupted                              |
| `MessageFailedEvent`       | Event emitted on message failure                                         |
| `QueuedResult`             | Result returned by `processMessage()` when a message is queued           |
| `SerializedNodeRef`        | Serialized node reference (id, name, type, status)                       |
| `SerializedTreeNode`       | Recursive serialized tree node with children                             |
| `generateMessageId`        | Utility to generate unique message IDs                                   |

## [State](state.md)

| Export                | Description                                                       |
| --------------------- | ----------------------------------------------------------------- |
| `StateStore`          | Interface for state persistence, locking, and event streaming     |
| `TreeSessionState`    | Persisted session state (blackboard, tree state, held flag)       |
| `TreeEvent`           | Persisted event (id, type, data, timestamp)                       |
| `InMemoryStateStore`  | In-memory `StateStore` for development                            |
| `RedisStateStore`     | Redis-backed `StateStore` for production                          |
| `RedisStateStoreOptions` | Options for `RedisStateStore` constructor                      |

## [Client SDK](client.md)

| Export                        | Description                                           |
| ----------------------------- | ----------------------------------------------------- |
| `createCartographerClient`    | Create a client connected to an `ActorServer`         |
| `CartographerClient`          | Client interface (action, write, interrupt, resume)   |
| `SendResponse`                | Response from `command()`, `write()`, `send()`        |
| `QueueFullError`              | Thrown on 429 (message queue is full)                 |

## [Logging](logging.md)

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
