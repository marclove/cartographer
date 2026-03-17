// Core types
export { NodeStatus } from './types.js';
export type {
  BTreeNode,
  TreeContext,
  Blackboard,
  TreeEvents,
  TypedEventEmitter,
  SelectionStrategy,
  ExecutionStrategy,
  ParallelPolicy,
  ParallelStrategy,
  AgentStrategyConfig,
  ActionNodeConfig,
  ConditionNodeConfig,
  AgentNodeConfig,
  SelectorConfig,
  SequenceConfig,
  ParallelConfig,
  DecoratorConfig,
  RepeatConfig,
  RetryConfig,
  TimeoutConfig,
  GuardConfig,
  BehaviorTreeConfig,
  SchedulerConfig,
  SchedulerEvents,
  TickLoopHandle,
  ModelUsage,
} from './types.js';

// Core
export { BehaviorTree } from './core/behavior-tree.js';
export { InMemoryBlackboard } from './core/blackboard.js';
export { EventEmitter } from './core/event-emitter.js';

// Leaf nodes
export { BaseNode } from './nodes/base.js';
export { ActionNode } from './nodes/action.js';
export { ConditionNode } from './nodes/condition.js';
export { AgentNode } from './nodes/agent.js';

// Composite nodes
export { SelectorNode } from './composites/selector.js';
export { SequenceNode } from './composites/sequence.js';
export { ParallelNode } from './composites/parallel.js';
export { isReactiveNode } from './composites/is-reactive-node.js';

// Decorators
export { InverterNode } from './decorators/inverter.js';
export { RepeatNode } from './decorators/repeat.js';
export { RetryNode } from './decorators/retry.js';
export { AlwaysSucceedNode } from './decorators/always-succeed.js';
export { AlwaysFailNode } from './decorators/always-fail.js';
export { TimeoutNode } from './decorators/timeout.js';
export { GuardNode } from './decorators/guard.js';

// Default strategies
export { DefaultSelectionStrategy } from './strategies/default-selection.js';
export { DefaultExecutionStrategy } from './strategies/default-execution.js';
export { DefaultParallelStrategy } from './strategies/default-parallel.js';

// Agent strategies
export { AgentSelectionStrategy } from './strategies/agent-selection.js';
export { AgentExecutionStrategy } from './strategies/agent-execution.js';
export { AgentParallelStrategy } from './strategies/agent-parallel.js';

// Builder
export { TreeBuilder, CompositeBuilder, SingleChildBuilder } from './builder/tree-builder.js';

// Config
export { TreeRegistry } from './config/registry.js';
export { TreeLoader } from './config/loader.js';

// Scheduler
export { TreeScheduler } from './scheduler/tree-scheduler.js';

// Agent integration
export { createBlackboardMcpServer } from './agent/blackboard-mcp.js';
export { emitMessageEvents, createStrategyMessageHandler, wrapElicitation } from './agent/sdk-helpers.js';

// Logging
export { createTreeLogger } from './tree-logger.js';
export type { TreeLoggerOptions } from './tree-logger.js';

// CLI types
export type { RunContext, TreeRunConfig } from './cli/types.js';

// SDK re-exports
export type { OnElicitation, ElicitationRequest } from '@anthropic-ai/claude-agent-sdk';

// Server
export { TreeServer } from './server/tree-server.js';
export type { TreeServerOptions } from './server/tree-server.js';
export type { SerializedNodeRef, SerializedTreeNode } from './server/serializers.js';

// Actor
export { TreeActor } from './actor/tree-actor.js';
export type { TreeActorOptions, ProcessResult } from './actor/tree-actor.js';
export type { ActorMessage, TickMessage, ActionMessage, WriteMessage, SignalMessage, MessageInterruptedEvent, MessageProcessedEvent, MessageFailedEvent } from './actor/types.js';
export { generateMessageId } from './actor/types.js';

// State
export type { StateStore, TreeSessionState, TreeEvent } from './state/state-store.js';
export { InMemoryStateStore } from './state/in-memory-state-store.js';
export { RedisStateStore } from './state/redis-state-store.js';
export type { RedisStateStoreOptions } from './state/redis-state-store.js';

// ActorServer
export { ActorServer } from './server/actor-server.js';
export type { ActorServerOptions } from './server/actor-server.js';
export { EventBridge } from './server/event-bridge.js';

// Client
export { createCartographerClient, ConflictError } from './client/index.js';
export type { CartographerClient } from './client/types.js';

// New nodes
export { untilSuccess, UntilSuccessNode } from './decorators/until-success.js';
export { actionReceived, ActionReceivedNode } from './nodes/action-received.js';
export { emitToClient, EmitToClientNode } from './nodes/emit-to-client.js';

// Serialization
export { serializeTree, restoreTree, buildHashIndex } from './core/serialization.js';
export type { SerializedTreeState, NodeState } from './core/serialization.js';
export { computeContentHash } from './core/content-hash.js';
