# Task 17: Package Exports and Final Verification

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire up `src/index.ts` with all public exports, run the full test suite, verify the build, and commit.

**Architecture:** Single barrel export file that re-exports everything users need from the package root.

**Tech Stack:** TypeScript

---

### Step 1: Write the public API export file

Update `src/index.ts`:

```typescript
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
} from './types.js';

// Core
export { BehaviorTree } from './core/behavior-tree.js';
export { MapBlackboard } from './core/blackboard.js';
export { EventEmitter } from './core/event-emitter.js';

// Leaf nodes
export { ActionNode } from './nodes/action.js';
export { ConditionNode } from './nodes/condition.js';
export { AgentNode } from './nodes/agent.js';

// Composite nodes
export { SelectorNode } from './composites/selector.js';
export { SequenceNode } from './composites/sequence.js';
export { ParallelNode } from './composites/parallel.js';

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
```

### Step 2: Run the full test suite

Run: `npx vitest run`
Expected: ALL tests pass across all test files.

### Step 3: Verify TypeScript build

Run: `npx tsc --noEmit`
Expected: No errors.

### Step 4: Build the package

Run: `npx tsc`
Expected: `dist/` directory created with compiled JS and declaration files.

### Step 5: Commit

```bash
git add src/index.ts
git commit -m "feat: wire up package exports for all public APIs"
```

### Step 6: Run full verification

Run:
```bash
npx vitest run && npx tsc --noEmit && echo "All checks pass"
```
Expected: All tests pass, TypeScript compiles cleanly, "All checks pass" printed.

### Step 7: Final commit with any fixes

If any fixes were needed:
```bash
git add -A
git commit -m "fix: resolve build and test issues from final verification"
```
