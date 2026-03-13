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
export { DashboardServer } from './server/dashboard-server.js';
export type { DashboardServerOptions } from './server/dashboard-server.js';
export type { SerializedNodeRef, SerializedTreeNode } from './server/serializers.js';
