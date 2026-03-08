# Task 13: Agent Strategies

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the three agent-powered strategies that use Claude to make JIT decisions about composite node behavior.

**Architecture:** Each strategy calls `query()` with structured output mode to get a typed decision. On failure, they fall back to default behavior (original order for selection/execution, require-all for parallel).

**Tech Stack:** TypeScript, @anthropic-ai/claude-agent-sdk, zod

---

### Step 1: Write failing tests

Create `src/strategies/agent-strategies.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeStatus } from '../types.js';
import type { BTreeNode, TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { MapBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name, _desc, _schema, handler) => handler),
}));

import { AgentSelectionStrategy } from './agent-selection.js';
import { AgentExecutionStrategy } from './agent-execution.js';
import { AgentParallelStrategy } from './agent-parallel.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

const mockQuery = vi.mocked(query);

function createContext(): TreeContext {
  return {
    blackboard: new MapBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

function mockNode(name: string): BTreeNode {
  return {
    id: name, name,
    tick: async () => NodeStatus.SUCCESS,
    reset: () => {}, abort: () => {},
  };
}

async function* mockMessages(messages: unknown[]) {
  for (const msg of messages) {
    yield msg;
  }
}

describe('AgentSelectionStrategy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reorders children based on Claude response', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: {
          ordering: ['c', 'a', 'b'],
          reasoning: 'c is most relevant',
        },
        total_cost_usd: 0.01,
      },
    ]) as any);

    const strategy = new AgentSelectionStrategy({
      prompt: 'Pick the best order',
      childDescriptions: { a: 'first', b: 'second', c: 'third' },
    });

    const children = [mockNode('a'), mockNode('b'), mockNode('c')];
    const result = await strategy.order(children, createContext());

    expect(result.map((n) => n.name)).toEqual(['c', 'a', 'b']);
  });

  it('falls back to original order on SDK failure', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'error_during_execution' },
    ]) as any);

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick order' });
    const children = [mockNode('a'), mockNode('b')];
    const result = await strategy.order(children, createContext());

    expect(result.map((n) => n.name)).toEqual(['a', 'b']);
  });

  it('falls back to original order if Claude returns unknown names', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: { ordering: ['x', 'y', 'z'], reasoning: 'random' },
        total_cost_usd: 0.01,
      },
    ]) as any);

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick order' });
    const children = [mockNode('a'), mockNode('b')];
    const result = await strategy.order(children, createContext());

    // Falls back because none of the names matched
    expect(result.map((n) => n.name)).toEqual(['a', 'b']);
  });

  it('emits strategy:decision event', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: { ordering: ['a'], reasoning: 'only one' },
        total_cost_usd: 0.01,
      },
    ]) as any);

    const strategy = new AgentSelectionStrategy({ prompt: 'Pick' });
    const ctx = createContext();
    const spy = vi.fn();
    ctx.events.on('strategy:decision', spy);

    await strategy.order([mockNode('a')], ctx);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'agent-selection' }),
    );
  });

  it('supports dynamic prompt function', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: { ordering: ['a'], reasoning: 'ok' },
        total_cost_usd: 0.01,
      },
    ]) as any);

    const strategy = new AgentSelectionStrategy({
      prompt: (children, ctx) => `Choose from ${children.length} options, state: ${ctx.blackboard.get('state')}`,
    });

    const ctx = createContext();
    ctx.blackboard.set('state', 'active');
    await strategy.order([mockNode('a')], ctx);

    expect(mockQuery).toHaveBeenCalled();
  });
});

describe('AgentExecutionStrategy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reorders children based on Claude response', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: { ordering: ['b', 'a'], reasoning: 'b first' },
        total_cost_usd: 0.01,
      },
    ]) as any);

    const strategy = new AgentExecutionStrategy({ prompt: 'Order steps' });
    const children = [mockNode('a'), mockNode('b')];
    const result = await strategy.order(children, createContext());

    expect(result.map((n) => n.name)).toEqual(['b', 'a']);
  });

  it('falls back to original order on failure', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'error_during_execution' },
    ]) as any);

    const strategy = new AgentExecutionStrategy({ prompt: 'Order' });
    const children = [mockNode('a'), mockNode('b')];
    const result = await strategy.order(children, createContext());

    expect(result.map((n) => n.name)).toEqual(['a', 'b']);
  });
});

describe('AgentParallelStrategy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns policy from Claude response', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'result',
        subtype: 'success',
        structured_output: {
          policy: { successCount: 2 },
          reasoning: 'need at least 2',
        },
        total_cost_usd: 0.01,
      },
    ]) as any);

    const strategy = new AgentParallelStrategy({ prompt: 'Set policy' });
    const children = [mockNode('a'), mockNode('b'), mockNode('c')];
    const result = await strategy.policy(children, createContext());

    expect(result).toEqual({ successCount: 2 });
  });

  it('falls back to require-all policy on failure', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'error_during_execution' },
    ]) as any);

    const strategy = new AgentParallelStrategy({ prompt: 'Set policy' });
    const children = [mockNode('a'), mockNode('b')];
    const result = await strategy.policy(children, createContext());

    expect(result).toEqual({ successCount: 2 });
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/strategies/agent-strategies.test.ts`
Expected: FAIL

### Step 3: Create shared helper for agent strategy queries

Create `src/agent/sdk-helpers.ts`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { BTreeNode, TreeContext, AgentStrategyConfig } from '../types.js';

export async function queryStructured<T extends z.ZodType>(
  prompt: string,
  schema: T,
  config: AgentStrategyConfig,
): Promise<z.infer<T> | null> {
  async function* generateMessages() {
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content: prompt },
    };
  }

  try {
    for await (const message of query({
      prompt: generateMessages(),
      options: {
        outputFormat: { type: 'json_schema', schema: z.toJSONSchema(schema) },
        model: config.model ?? 'sonnet',
        effort: config.effort ?? 'low',
        maxTurns: 1,
      },
    } as any)) {
      const msg = message as any;
      if (msg.type === 'result') {
        if (msg.subtype === 'success' && msg.structured_output) {
          return msg.structured_output as z.infer<T>;
        }
        return null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function buildStrategyPrompt(
  config: AgentStrategyConfig,
  children: BTreeNode[],
  context: TreeContext,
): string {
  const basePrompt = typeof config.prompt === 'function'
    ? config.prompt(children, context)
    : config.prompt;

  const childInfo = children.map((c) => ({
    name: c.name,
    description: config.childDescriptions?.[c.name] ?? c.name,
  }));

  const blackboardState: Record<string, unknown> = {};
  for (const key of context.blackboard.keys()) {
    blackboardState[key] = context.blackboard.get(key);
  }

  return `${basePrompt}\n\nAvailable children:\n${JSON.stringify(childInfo, null, 2)}\n\nBlackboard state:\n${JSON.stringify(blackboardState, null, 2)}`;
}
```

### Step 4: Implement AgentSelectionStrategy

Create `src/strategies/agent-selection.ts`:

```typescript
import { z } from 'zod';
import type { SelectionStrategy, BTreeNode, TreeContext, AgentStrategyConfig } from '../types.js';
import { queryStructured, buildStrategyPrompt } from '../agent/sdk-helpers.js';

const OrderingSchema = z.object({
  ordering: z.array(z.string()).describe('Child node names in the order they should be tried'),
  reasoning: z.string().describe('Brief explanation of the ordering decision'),
});

export class AgentSelectionStrategy implements SelectionStrategy {
  constructor(private config: AgentStrategyConfig) {}

  async order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]> {
    const prompt = buildStrategyPrompt(this.config, children, context);
    const result = await queryStructured(prompt, OrderingSchema, this.config);

    if (!result) {
      return children;
    }

    context.events.emit('strategy:decision', {
      composite: children[0] ?? ({ id: '', name: '' } as any),
      strategy: 'agent-selection',
      decision: result,
    });

    const nameToChild = new Map(children.map((c) => [c.name, c]));
    const reordered = result.ordering
      .map((name: string) => nameToChild.get(name))
      .filter((c): c is BTreeNode => c !== undefined);

    // Fall back if Claude returned names that don't match any children
    if (reordered.length === 0) {
      return children;
    }

    return reordered;
  }
}
```

### Step 5: Implement AgentExecutionStrategy

Create `src/strategies/agent-execution.ts`:

```typescript
import { z } from 'zod';
import type { ExecutionStrategy, BTreeNode, TreeContext, AgentStrategyConfig } from '../types.js';
import { queryStructured, buildStrategyPrompt } from '../agent/sdk-helpers.js';

const OrderingSchema = z.object({
  ordering: z.array(z.string()).describe('Child node names in execution order'),
  reasoning: z.string().describe('Brief explanation of the ordering decision'),
});

export class AgentExecutionStrategy implements ExecutionStrategy {
  constructor(private config: AgentStrategyConfig) {}

  async order(children: BTreeNode[], context: TreeContext): Promise<BTreeNode[]> {
    const prompt = buildStrategyPrompt(this.config, children, context);
    const result = await queryStructured(prompt, OrderingSchema, this.config);

    if (!result) {
      return children;
    }

    context.events.emit('strategy:decision', {
      composite: children[0] ?? ({ id: '', name: '' } as any),
      strategy: 'agent-execution',
      decision: result,
    });

    const nameToChild = new Map(children.map((c) => [c.name, c]));
    const reordered = result.ordering
      .map((name: string) => nameToChild.get(name))
      .filter((c): c is BTreeNode => c !== undefined);

    if (reordered.length === 0) {
      return children;
    }

    return reordered;
  }
}
```

### Step 6: Implement AgentParallelStrategy

Create `src/strategies/agent-parallel.ts`:

```typescript
import { z } from 'zod';
import type { ParallelStrategy, ParallelPolicy, BTreeNode, TreeContext, AgentStrategyConfig } from '../types.js';
import { queryStructured, buildStrategyPrompt } from '../agent/sdk-helpers.js';

const PolicySchema = z.object({
  policy: z.object({
    successCount: z.number().optional(),
    successPercentage: z.number().optional(),
    failureCount: z.number().optional(),
  }).describe('The parallel execution policy'),
  reasoning: z.string().describe('Brief explanation of the policy decision'),
});

export class AgentParallelStrategy implements ParallelStrategy {
  constructor(private config: AgentStrategyConfig) {}

  async policy(children: BTreeNode[], context: TreeContext): Promise<ParallelPolicy> {
    const prompt = buildStrategyPrompt(this.config, children, context);
    const result = await queryStructured(prompt, PolicySchema, this.config);

    if (!result) {
      return { successCount: children.length };
    }

    context.events.emit('strategy:decision', {
      composite: children[0] ?? ({ id: '', name: '' } as any),
      strategy: 'agent-parallel',
      decision: result,
    });

    return result.policy;
  }
}
```

### Step 7: Run test to verify it passes

Run: `npx vitest run src/strategies/agent-strategies.test.ts`
Expected: PASS (all 9 tests)

### Step 8: Commit

```bash
git add src/agent/sdk-helpers.ts src/strategies/agent-selection.ts src/strategies/agent-execution.ts src/strategies/agent-parallel.ts src/strategies/agent-strategies.test.ts
git commit -m "feat: implement agent-powered strategies for selection, execution, and parallel composites"
```
