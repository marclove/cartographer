# Cartographer: Agentic Behavior Tree Framework

A TypeScript framework that combines traditional behavior tree patterns with Claude Agent SDK integration, enabling deterministic and non-deterministic (agentic) nodes to coexist in a structured execution tree.

## Problem

Building reliable AI agent workflows requires balancing autonomy with structure. Pure agentic approaches lack guardrails; pure deterministic approaches can't adapt to novel situations. Behavior trees provide a proven execution model from game AI that naturally supports this mix — deterministic composite logic with intelligent leaf nodes that can reason and act.

## Approach: Strategy Pattern for Composite Behavior

Composites delegate their child-selection/policy logic to a Strategy object. Default strategies are deterministic (standard BT semantics). Agent strategies use Claude to make JIT decisions. Agent leaf nodes are a distinct leaf type with two execution modes.

## Core Types

```typescript
enum NodeStatus {
  SUCCESS = 'success',
  FAILURE = 'failure',
  RUNNING = 'running',
}

interface TreeContext {
  blackboard: Blackboard;
  events: EventEmitter<TreeEvents>;
  signal?: AbortSignal;
}

interface BTreeNode {
  readonly id: string;
  readonly name: string;
  tick(context: TreeContext): Promise<NodeStatus>;
  reset(): void;
  abort(): void;
}
```

### Blackboard

Key-value store shared across the tree. Supports namespaced scoping so agent nodes can be sandboxed.

```typescript
interface Blackboard {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  has(key: string): boolean;
  delete(key: string): void;
  keys(): string[];
  scoped(namespace: string): Blackboard;
}
```

### Events

Typed event emitter for observability.

```typescript
interface TreeEvents {
  'node:enter': { node: BTreeNode; context: TreeContext };
  'node:exit': { node: BTreeNode; status: NodeStatus; context: TreeContext; durationMs: number };
  'node:error': { node: BTreeNode; error: Error; context: TreeContext };
  'agent:prompt': { node: BTreeNode; prompt: string; mode: 'structured' | 'agentic' };
  'agent:response': { node: BTreeNode; result: unknown; cost?: number };
  'agent:tool_use': { node: BTreeNode; tool: string; input: unknown };
  'blackboard:write': { key: string; value: unknown; source: string };
  'strategy:decision': { composite: BTreeNode; strategy: string; decision: unknown };
}
```

## Leaf Nodes

### ActionNode

Runs user-defined sync or async functions.

```typescript
interface ActionNodeConfig {
  name: string;
  action: (context: TreeContext) => Promise<NodeStatus> | NodeStatus;
}
```

### ConditionNode

Evaluates a predicate, returns SUCCESS or FAILURE (never RUNNING).

```typescript
interface ConditionNodeConfig {
  name: string;
  condition: (context: TreeContext) => Promise<boolean> | boolean;
}
```

### AgentNode

Wraps the Claude Agent SDK in two modes.

```typescript
interface AgentNodeConfig {
  name: string;
  mode: 'structured' | 'agentic';
  prompt: string | ((context: TreeContext) => string);

  // Structured mode
  outputSchema?: z.ZodType;
  mapResult?: (output: unknown, context: TreeContext) => NodeStatus;

  // Agentic mode
  allowedTools?: string[];
  permissionMode?: 'acceptEdits' | 'bypassPermissions' | 'default';
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  mcpServers?: Record<string, any>;

  // Common
  model?: 'sonnet' | 'opus' | 'haiku';
  effort?: 'low' | 'medium' | 'high' | 'max';
  blackboardNamespace?: string;
}
```

**Structured mode:** Calls `query()` with Zod schema as `outputFormat`, passes parsed output to `mapResult()` to determine status. Defaults to `effort: 'low'` and `maxTurns: 1`.

**Agentic mode:** Calls `query()` with full tool set and options. Creates a blackboard MCP server scoped to the node's namespace. Maps `ResultMessage.subtype === 'success'` to SUCCESS, anything else to FAILURE. Defaults to `effort: 'high'`.

Both modes auto-write output to blackboard under `{nodeName}:output`.

## Composite Nodes

Composites delegate their core logic to strategy objects.

### Selector

Tries children until one succeeds.

```typescript
interface SelectionStrategy {
  order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]>;
}
```

Tick: `strategy.order()` -> iterate -> first SUCCESS returns SUCCESS, first RUNNING returns RUNNING, all FAILURE returns FAILURE.

### Sequence

Runs children until one fails.

```typescript
interface ExecutionStrategy {
  order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]>;
}
```

Tick: `strategy.order()` -> iterate -> first FAILURE returns FAILURE, first RUNNING returns RUNNING, all SUCCESS returns SUCCESS.

### Parallel

Runs children concurrently, policy determines outcome.

```typescript
interface ParallelPolicy {
  successCount?: number;
  successPercentage?: number;
  failureCount?: number;
}

interface ParallelStrategy {
  policy(children: BTreeNode[], context: TreeContext): Promise<ParallelPolicy>;
}
```

Tick: `strategy.policy()` -> tick all via `Promise.all` -> count against thresholds.

### Agent Strategies

Agent strategies use structured output mode internally — they query Claude with child descriptions and blackboard state, get back a typed reordering or policy object. They always fall back to default behavior on failure.

```typescript
interface AgentStrategyConfig {
  prompt: string | ((children: BTreeNode[], context: TreeContext) => string);
  model?: 'sonnet' | 'opus' | 'haiku';
  effort?: 'low' | 'medium' | 'high' | 'max';
  childDescriptions?: Record<string, string>;
}
```

## Decorator Nodes

Standard BT decorators that wrap a single child and modify its behavior.

- **InverterNode** — flips SUCCESS/FAILURE, passes RUNNING through
- **RepeatNode** — repeats child N times or until a target status
- **RetryNode** — retries child up to N times on FAILURE, with optional delay
- **AlwaysSucceedNode** — returns SUCCESS regardless of child result
- **AlwaysFailNode** — returns FAILURE regardless of child result
- **TimeoutNode** — fails if child doesn't complete within timeout
- **GuardNode** — only ticks child if guard condition passes

No decorator has agent awareness; they operate purely on NodeStatus.

## Tree Runner and Scheduler

### BehaviorTree

Root container that runs a single tick to completion.

```typescript
class BehaviorTree {
  readonly events: EventEmitter<TreeEvents>;
  readonly blackboard: Blackboard;

  constructor(config: BehaviorTreeConfig);
  async tick(): Promise<NodeStatus>;
  async run(): Promise<{ status: NodeStatus; blackboard: Record<string, unknown> }>;
  abort(): void;
  reset(): void;
}
```

### TreeScheduler

Isolated CRON-like runner. The tree knows nothing about scheduling.

```typescript
interface SchedulerConfig {
  tree: BehaviorTree;
  schedule:
    | { type: 'cron'; expression: string }
    | { type: 'interval'; ms: number }
    | { type: 'once' };
  maxRuns?: number;
  stopOnStatus?: NodeStatus;
  resetBetweenTicks?: boolean;  // default: true
  onError?: 'stop' | 'continue' | ((error: Error, runCount: number) => 'stop' | 'continue');
}

class TreeScheduler {
  readonly events: EventEmitter<SchedulerEvents>;
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly isRunning: boolean;
  readonly runCount: number;
  readonly lastStatus?: NodeStatus;
}
```

## Declarative Config and Builder API

### Fluent Builder

```typescript
const tree = BehaviorTree.create('patrol-and-respond')
  .selector('root', s => s
    .strategy(new AgentSelectionStrategy({ prompt: '...' }))
    .sequence('handle-critical', seq => seq
      .condition('is-critical', ctx => ctx.blackboard.get('alertLevel') === 'critical')
      .agent('analyze', { mode: 'structured', prompt: '...', outputSchema: Schema })
    )
    .action('fallback', ctx => NodeStatus.SUCCESS)
  )
  .build();
```

### YAML Config

```yaml
name: patrol-and-respond
root:
  type: selector
  name: root
  strategy:
    type: agent
    prompt: "..."
  children:
    - type: sequence
      name: handle-critical
      children:
        - type: condition
          name: is-critical
          ref: conditions.isCritical
        - type: agent
          name: analyze
          mode: structured
          prompt: "..."
          outputSchema: ThreatAnalysis
```

### Registry

YAML can't contain functions. User-defined actions/conditions are registered by name.

```typescript
interface TreeRegistry {
  registerAction(name: string, fn: (context: TreeContext) => Promise<NodeStatus> | NodeStatus): void;
  registerCondition(name: string, fn: (context: TreeContext) => Promise<boolean> | boolean): void;
  registerSchema(name: string, schema: z.ZodType): void;
  registerStrategy(name: string, strategy: SelectionStrategy | ExecutionStrategy | ParallelStrategy): void;
}
```

## Agent SDK Integration

### Blackboard MCP Server

Created per agent node execution using `createSdkMcpServer` and `tool()`. Exposes `blackboard_read`, `blackboard_write`, and `blackboard_keys` tools. Scoped to the node's namespace if configured.

### Agent Strategy Queries

Agent strategies use structured output with a Zod schema to get typed decisions from Claude. For selection/execution strategies, the schema is an ordered array of child names. For parallel strategies, the schema is a `ParallelPolicy` object. On failure, strategies fall back to default behavior — the tree remains resilient.

## Package Structure

```
cartographer/
├── src/
│   ├── index.ts
│   ├── types.ts
│   ├── core/
│   │   ├── blackboard.ts
│   │   ├── behavior-tree.ts
│   │   └── event-emitter.ts
│   ├── nodes/
│   │   ├── base.ts
│   │   ├── action.ts
│   │   ├── condition.ts
│   │   └── agent.ts
│   ├── composites/
│   │   ├── selector.ts
│   │   ├── sequence.ts
│   │   └── parallel.ts
│   ├── decorators/
│   │   ├── inverter.ts
│   │   ├── repeat.ts
│   │   ├── retry.ts
│   │   ├── always-succeed.ts
│   │   ├── always-fail.ts
│   │   ├── timeout.ts
│   │   └── guard.ts
│   ├── strategies/
│   │   ├── types.ts
│   │   ├── default-selection.ts
│   │   ├── default-execution.ts
│   │   ├── default-parallel.ts
│   │   ├── agent-selection.ts
│   │   ├── agent-execution.ts
│   │   └── agent-parallel.ts
│   ├── agent/
│   │   ├── blackboard-mcp.ts
│   │   └── sdk-helpers.ts
│   ├── builder/
│   │   └── tree-builder.ts
│   ├── config/
│   │   ├── loader.ts
│   │   ├── registry.ts
│   │   └── schema.ts
│   └── scheduler/
│       └── tree-scheduler.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### Dependencies

- `@anthropic-ai/claude-agent-sdk` — Agent SDK
- `zod` — Schema validation and structured outputs
- `yaml` — YAML config parsing
- `cron-parser` — CRON expression parsing
- `uuid` — Node ID generation

### Dev Dependencies

- `typescript`, `vitest`, `tsx`
