# Task 23: Agent Strategies Integration Tests

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Test AgentExecutionStrategy, AgentParallelStrategy, and AgentSelectionStrategy integration with composites, using mocked SDK for logic tests and one live API test for end-to-end validation.

**Architecture:** 4 mocked tests + 1 live test. Mocks `queryStructured` from `src/agent/sdk-helpers.ts` using `vi.mock` so strategy classes receive controlled responses. Tests verify that strategies correctly reorder children, apply policies, cache results, and clear cache on reset.

**Tech Stack:** TypeScript, vitest, zod

**Key files to understand:**
- `src/agent/sdk-helpers.ts` — `queryStructured` function (the mock target) and `buildStrategyPrompt`
- `src/strategies/agent-execution.ts` — orders sequence children via SDK
- `src/strategies/agent-parallel.ts` — sets parallel policy via SDK
- `src/strategies/agent-selection.ts` — orders selector children via SDK

---

### Step 1: Create agent-strategies.test.ts

Create `src/__integration__/agent-strategies.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeStatus } from '../types.js';
import { ActionNode } from '../nodes/action.js';
import { SequenceNode } from '../composites/sequence.js';
import { ParallelNode } from '../composites/parallel.js';
import { AgentExecutionStrategy } from '../strategies/agent-execution.js';
import { AgentParallelStrategy } from '../strategies/agent-parallel.js';
import { AgentSelectionStrategy } from '../strategies/agent-selection.js';
import { createContext, collectEvents } from './helpers.js';

// Mock the SDK helper — this replaces the real queryStructured with a vi.fn()
vi.mock('../agent/sdk-helpers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../agent/sdk-helpers.js')>();
  return {
    ...original,
    queryStructured: vi.fn(),
  };
});

// Import after mock setup
import { queryStructured } from '../agent/sdk-helpers.js';

const mockedQueryStructured = vi.mocked(queryStructured);

describe('Agent Strategies Integration (Mocked SDK)', () => {
  beforeEach(() => {
    mockedQueryStructured.mockReset();
  });

  it('AgentExecutionStrategy reorders sequence children', async () => {
    mockedQueryStructured.mockResolvedValue({
      ordering: ['c', 'a', 'b'],
      reasoning: 'test ordering',
    });

    const ctx = createContext({ order: [] as string[] });
    const strategyEvents = collectEvents(ctx, 'strategy:decision');

    const makeChild = (name: string) =>
      new ActionNode({
        name,
        action: (ctx) => {
          const order = ctx.blackboard.get<string[]>('order')!;
          order.push(name);
          ctx.blackboard.set('order', order);
          return NodeStatus.SUCCESS;
        },
      });

    const strategy = new AgentExecutionStrategy({
      prompt: 'Order these steps',
      model: 'haiku',
    });

    const sequence = new SequenceNode({
      name: 'reordered-seq',
      children: [makeChild('a'), makeChild('b'), makeChild('c')],
      strategy,
    });

    const status = await sequence.tick(ctx);

    expect(status).toBe(NodeStatus.SUCCESS);
    expect(ctx.blackboard.get('order')).toEqual(['c', 'a', 'b']);
    expect(strategyEvents).toHaveLength(1);
    expect(strategyEvents[0].strategy).toBe('agent-execution');
    expect(mockedQueryStructured).toHaveBeenCalledOnce();
  });

  it('AgentParallelStrategy sets policy', async () => {
    mockedQueryStructured.mockResolvedValue({
      policy: { successCount: 1 },
      reasoning: 'only need one',
    });

    const ctx = createContext();
    const strategyEvents = collectEvents(ctx, 'strategy:decision');

    const parallel = new ParallelNode({
      name: 'policy-par',
      children: [
        new ActionNode({ name: 'fast', action: () => NodeStatus.SUCCESS }),
        new ActionNode({ name: 'slow-1', action: () => NodeStatus.FAILURE }),
        new ActionNode({ name: 'slow-2', action: () => NodeStatus.FAILURE }),
      ],
      strategy: new AgentParallelStrategy({
        prompt: 'Set the policy',
        model: 'haiku',
      }),
    });

    // With successCount: 1 and 1 SUCCESS child, parallel should return SUCCESS
    const status = await parallel.tick(ctx);

    expect(status).toBe(NodeStatus.SUCCESS);
    expect(strategyEvents).toHaveLength(1);
    expect(strategyEvents[0].strategy).toBe('agent-parallel');
    expect(mockedQueryStructured).toHaveBeenCalledOnce();
  });

  it('strategy caching — SDK called once for two order() calls', async () => {
    mockedQueryStructured.mockResolvedValue({
      ordering: ['a', 'b'],
      reasoning: 'default',
    });

    const strategy = new AgentSelectionStrategy({
      prompt: 'Order these',
      model: 'haiku',
      cache: true,
    });

    const children = [
      new ActionNode({ name: 'a', action: () => NodeStatus.SUCCESS }),
      new ActionNode({ name: 'b', action: () => NodeStatus.SUCCESS }),
    ];

    const ctx = createContext();

    await strategy.order(children, ctx);
    await strategy.order(children, ctx);

    expect(mockedQueryStructured).toHaveBeenCalledOnce();
  });

  it('strategy reset clears cache — SDK called twice', async () => {
    mockedQueryStructured.mockResolvedValue({
      ordering: ['a', 'b'],
      reasoning: 'default',
    });

    const strategy = new AgentSelectionStrategy({
      prompt: 'Order these',
      model: 'haiku',
      cache: true,
    });

    const children = [
      new ActionNode({ name: 'a', action: () => NodeStatus.SUCCESS }),
      new ActionNode({ name: 'b', action: () => NodeStatus.SUCCESS }),
    ];

    const ctx = createContext();

    await strategy.order(children, ctx);
    strategy.reset();
    await strategy.order(children, ctx);

    expect(mockedQueryStructured).toHaveBeenCalledTimes(2);
  });
});

// --- Live API test ---
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!HAS_KEY)('Agent Strategies Integration (Live API)', { timeout: 30_000 }, () => {
  it('AgentParallelStrategy end-to-end with live API', async () => {
    // This test uses the REAL queryStructured (not the mock).
    // Since vi.mock is hoisted, we need to restore it for this test.
    mockedQueryStructured.mockRestore();

    // Re-import to get the real implementation
    const { queryStructured: realQueryStructured } = await import('../agent/sdk-helpers.js');

    const ctx = createContext();
    const strategyEvents = collectEvents(ctx, 'strategy:decision');

    const strategy = new AgentParallelStrategy({
      prompt: 'Choose a policy that requires at least 2 successes out of 3 children.',
      model: 'haiku',
      effort: 'low',
    });

    const children = [
      new ActionNode({ name: 'task-a', action: () => NodeStatus.SUCCESS }),
      new ActionNode({ name: 'task-b', action: () => NodeStatus.SUCCESS }),
      new ActionNode({ name: 'task-c', action: () => NodeStatus.SUCCESS }),
    ];

    const parallel = new ParallelNode({
      name: 'live-par',
      children,
      strategy,
    });

    const status = await parallel.tick(ctx);

    // All 3 succeed, and policy should require >= 2, so SUCCESS
    expect(status).toBe(NodeStatus.SUCCESS);
    expect(strategyEvents).toHaveLength(1);

    const decision = strategyEvents[0].decision as any;
    expect(decision.policy).toBeDefined();
    expect(typeof decision.reasoning).toBe('string');
  });
});
```

**Important note on the live test:** The `vi.mock` is hoisted and affects all tests in the file. The live test calls `mockRestore()` to restore the original implementation. If this causes issues during implementation, an alternative approach is to move the live test to a separate file (e.g., `agent-strategies-live.test.ts`). Adjust as needed when implementing.

### Step 2: Run tests

Run: `npx vitest run src/__integration__/agent-strategies.test.ts`
Expected: 4 mocked tests PASS. Live test passes if `ANTHROPIC_API_KEY` is set, skipped otherwise.

### Step 3: Run all unit tests to verify no regressions

Run: `npm run test`
Expected: All unit tests pass.

### Step 4: Commit

```bash
git add src/__integration__/agent-strategies.test.ts
git commit -m "test: add agent strategies integration tests with mocked and live SDK"
```
