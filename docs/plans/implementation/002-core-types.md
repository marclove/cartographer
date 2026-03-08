# Task 2: Core Types

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Define the foundational types that the entire framework builds on: NodeStatus, BTreeNode, TreeContext, Blackboard, and TreeEvents.

**Architecture:** Pure type definitions in `src/types.ts`. No implementations yet — just the contracts.

**Tech Stack:** TypeScript

---

### Step 1: Write tests for NodeStatus enum values

Create `src/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { NodeStatus } from './types.js';

describe('NodeStatus', () => {
  it('has SUCCESS, FAILURE, and RUNNING values', () => {
    expect(NodeStatus.SUCCESS).toBe('success');
    expect(NodeStatus.FAILURE).toBe('failure');
    expect(NodeStatus.RUNNING).toBe('running');
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/types.test.ts`
Expected: FAIL — cannot import from `./types.js`

### Step 3: Write types.ts with all core types

Create `src/types.ts`:

```typescript
import type { z } from 'zod';

// --- Node Status ---

export enum NodeStatus {
  SUCCESS = 'success',
  FAILURE = 'failure',
  RUNNING = 'running',
}

// --- Blackboard ---

export interface Blackboard {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  has(key: string): boolean;
  delete(key: string): void;
  keys(): string[];
  scoped(namespace: string): Blackboard;
}

// --- Event Emitter ---

export interface TreeEvents {
  'node:enter': { node: BTreeNode; context: TreeContext };
  'node:exit': { node: BTreeNode; status: NodeStatus; context: TreeContext; durationMs: number };
  'node:error': { node: BTreeNode; error: Error; context: TreeContext };
  'agent:prompt': { node: BTreeNode; prompt: string; mode: 'structured' | 'agentic' };
  'agent:response': { node: BTreeNode; result: unknown; cost?: number };
  'agent:tool_use': { node: BTreeNode; tool: string; input: unknown };
  'blackboard:write': { key: string; value: unknown; source: string };
  'strategy:decision': { composite: BTreeNode; strategy: string; decision: unknown };
}

export interface TypedEventEmitter<TEvents extends Record<string, unknown>> {
  on<K extends keyof TEvents & string>(event: K, listener: (data: TEvents[K]) => void): void;
  off<K extends keyof TEvents & string>(event: K, listener: (data: TEvents[K]) => void): void;
  emit<K extends keyof TEvents & string>(event: K, data: TEvents[K]): void;
  removeAllListeners(): void;
}

// --- Tree Context ---

export interface TreeContext {
  blackboard: Blackboard;
  events: TypedEventEmitter<TreeEvents>;
  signal?: AbortSignal;
}

// --- Node Interface ---

export interface BTreeNode {
  readonly id: string;
  readonly name: string;
  tick(context: TreeContext): Promise<NodeStatus>;
  reset(): void;
  abort(): void;
}

// --- Strategy Interfaces ---

export interface SelectionStrategy {
  order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]>;
}

export interface ExecutionStrategy {
  order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]>;
}

export interface ParallelPolicy {
  successCount?: number;
  successPercentage?: number;
  failureCount?: number;
}

export interface ParallelStrategy {
  policy(children: BTreeNode[], context: TreeContext): Promise<ParallelPolicy>;
}

// --- Agent Strategy Config ---

export interface AgentStrategyConfig {
  prompt: string | ((children: BTreeNode[], context: TreeContext) => string);
  model?: 'sonnet' | 'opus' | 'haiku';
  effort?: 'low' | 'medium' | 'high' | 'max';
  childDescriptions?: Record<string, string>;
}

// --- Node Configs ---

export interface ActionNodeConfig {
  name: string;
  action: (context: TreeContext) => Promise<NodeStatus> | NodeStatus;
}

export interface ConditionNodeConfig {
  name: string;
  condition: (context: TreeContext) => Promise<boolean> | boolean;
}

export interface AgentNodeConfig {
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
  mcpServers?: Record<string, unknown>;

  // Common
  model?: 'sonnet' | 'opus' | 'haiku';
  effort?: 'low' | 'medium' | 'high' | 'max';
  blackboardNamespace?: string;
}

// --- Composite Configs ---

export interface SelectorConfig {
  name: string;
  children: BTreeNode[];
  strategy?: SelectionStrategy;
}

export interface SequenceConfig {
  name: string;
  children: BTreeNode[];
  strategy?: ExecutionStrategy;
}

export interface ParallelConfig {
  name: string;
  children: BTreeNode[];
  strategy?: ParallelStrategy;
}

// --- Decorator Configs ---

export interface DecoratorConfig {
  name: string;
  child: BTreeNode;
}

export interface RepeatConfig extends DecoratorConfig {
  count?: number;
  untilStatus?: NodeStatus;
}

export interface RetryConfig extends DecoratorConfig {
  maxAttempts: number;
  delayMs?: number;
}

export interface TimeoutConfig extends DecoratorConfig {
  timeoutMs: number;
}

export interface GuardConfig extends DecoratorConfig {
  condition: (context: TreeContext) => Promise<boolean> | boolean;
}

// --- Behavior Tree Config ---

export interface BehaviorTreeConfig {
  name: string;
  root: BTreeNode;
  blackboard?: Blackboard;
}

// --- Scheduler ---

export interface SchedulerConfig {
  tree: { tick(): Promise<NodeStatus>; reset(): void; readonly events: TypedEventEmitter<TreeEvents> };
  schedule:
    | { type: 'cron'; expression: string }
    | { type: 'interval'; ms: number }
    | { type: 'once' };
  maxRuns?: number;
  stopOnStatus?: NodeStatus;
  resetBetweenTicks?: boolean;
  onError?: 'stop' | 'continue' | ((error: Error, runCount: number) => 'stop' | 'continue');
}

export interface SchedulerEvents {
  'tick:start': { runCount: number; timestamp: Date };
  'tick:complete': { runCount: number; status: NodeStatus; durationMs: number };
  'tick:error': { runCount: number; error: Error };
  'scheduler:stop': { reason: 'manual' | 'maxRuns' | 'stopOnStatus' | 'error' };
}
```

### Step 4: Run test to verify it passes

Run: `npx vitest run src/types.test.ts`
Expected: PASS

### Step 5: Commit

```bash
git add src/types.ts src/types.test.ts
git commit -m "feat: add core type definitions for nodes, blackboard, events, strategies, and configs"
```
