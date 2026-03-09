# Task 22: Agent Agentic Mode Integration Tests

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Test AgentNode in agentic mode with MCP tool use, tree pipelines with agentic agents, mapResult failure mapping, and agent caching.

**Architecture:** 4 live API integration tests gated by `ANTHROPIC_API_KEY`. All use `model: 'haiku'`, `effort: 'low'` to minimize cost. Tests verify blackboard state, event emission, and caching behavior.

**Tech Stack:** TypeScript, vitest, @anthropic-ai/claude-agent-sdk, zod

**Key files to understand:**
- `src/nodes/agent.ts` — `AgentNode` implementation with `executeStructured` and `executeAgentic` methods
- `src/agent/blackboard-mcp.ts` — MCP server that exposes blackboard via `blackboard_read`, `blackboard_write`, `blackboard_keys` tools
- `src/types.ts:105-127` — `AgentNodeConfig` type

---

### Step 1: Create agent-agentic-mode.test.ts

Create `src/__integration__/agent-agentic-mode.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { z } from 'zod/v4';
import { NodeStatus } from '../types.js';
import { AgentNode } from '../nodes/agent.js';
import { TreeBuilder } from '../builder/tree-builder.js';
import { createContext, collectEvents } from './helpers.js';

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!HAS_KEY)('Agent Agentic Mode Integration', { timeout: 30_000 }, () => {
  it('agentic mode with blackboard MCP tool use', async () => {
    const ctx = createContext({
      items: ['apple', 'banana', 'cherry'],
    });

    const toolUseEvents = collectEvents(ctx, 'agent:tool_use');
    const responseEvents = collectEvents(ctx, 'agent:response');

    const agent = new AgentNode({
      name: 'mcp-agent',
      mode: 'agentic',
      prompt:
        "Read the 'items' key from the blackboard. Join the items with commas into a single string and write it to the 'summary' key on the blackboard.",
      model: 'haiku',
      effort: 'low',
      maxTurns: 5,
    });

    const status = await agent.tick(ctx);

    expect(status).toBe(NodeStatus.SUCCESS);
    expect(responseEvents.length).toBeGreaterThanOrEqual(1);
    expect(toolUseEvents.length).toBeGreaterThanOrEqual(1);

    // Verify blackboard was written via MCP
    const summary = ctx.blackboard.get<string>('summary');
    expect(summary).toBeDefined();
    expect(summary).toContain('apple');
    expect(summary).toContain('banana');
    expect(summary).toContain('cherry');
  });

  it('agentic mode in a tree pipeline', async () => {
    const tree = new TreeBuilder('agentic-pipeline')
      .sequence('main', (b) => {
        b.action('write-data', (ctx) => {
          ctx.blackboard.set('numbers', [10, 20, 30]);
          return NodeStatus.SUCCESS;
        });
        b.agent('transformer', {
          mode: 'agentic',
          prompt:
            "Read the 'numbers' key from the blackboard. Calculate their sum and write it to the 'total' key on the blackboard.",
          model: 'haiku',
          effort: 'low',
          maxTurns: 5,
        });
        b.condition('verify', (ctx) => {
          const total = ctx.blackboard.get<number>('total');
          return total !== undefined && total === 60;
        });
      })
      .build();

    const { status } = await tree.run();
    expect(status).toBe(NodeStatus.SUCCESS);
    expect(tree.blackboard.get('total')).toBe(60);
  });

  it('agent failure mapping with mapResult', async () => {
    const SafetySchema = z.object({
      safe: z.boolean(),
      reason: z.string(),
    });

    const ctx = createContext();
    const responseEvents = collectEvents(ctx, 'agent:response');

    const agent = new AgentNode({
      name: 'safety-check',
      mode: 'structured',
      prompt: 'Evaluate whether this database command is safe: "DROP TABLE users". Respond with safe: false if dangerous.',
      outputSchema: SafetySchema,
      model: 'haiku',
      effort: 'low',
      mapResult: (output: unknown) => {
        const result = output as z.infer<typeof SafetySchema>;
        return result.safe ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
      },
    });

    const status = await agent.tick(ctx);

    expect(status).toBe(NodeStatus.FAILURE);
    expect(responseEvents).toHaveLength(1);

    // Output should still be written to blackboard even though mapResult returned FAILURE
    const output = ctx.blackboard.get<z.infer<typeof SafetySchema>>('safety-check:output');
    expect(output).toBeDefined();
    expect(output!.safe).toBe(false);
    expect(output!.reason).toBeTruthy();
  });

  it('agent caching — SDK called once, reset clears cache', async () => {
    const ctx = createContext();
    const responseEvents = collectEvents(ctx, 'agent:response');

    const CountSchema = z.object({
      count: z.number(),
    });

    const agent = new AgentNode({
      name: 'cached-agent',
      mode: 'structured',
      prompt: 'Return the number 42.',
      outputSchema: CountSchema,
      model: 'haiku',
      effort: 'low',
      cache: true,
    });

    // First tick — makes API call
    const status1 = await agent.tick(ctx);
    expect(status1).toBe(NodeStatus.SUCCESS);
    expect(responseEvents).toHaveLength(1);

    // Second tick — uses cache, no new API call
    const status2 = await agent.tick(ctx);
    expect(status2).toBe(NodeStatus.SUCCESS);
    expect(responseEvents).toHaveLength(1); // still 1

    // Reset clears cache
    agent.reset();

    // Third tick — makes new API call
    const status3 = await agent.tick(ctx);
    expect(status3).toBe(NodeStatus.SUCCESS);
    expect(responseEvents).toHaveLength(2); // now 2
  });
});
```

### Step 2: Run integration tests (requires ANTHROPIC_API_KEY)

Run: `npm run test:integration`
Expected: If `ANTHROPIC_API_KEY` is set, all 4 tests pass. If not, tests are skipped.

### Step 3: Run all unit tests to verify no regressions

Run: `npm run test`
Expected: All unit tests pass.

### Step 4: Commit

```bash
git add src/__integration__/agent-agentic-mode.test.ts
git commit -m "test: add agent agentic mode integration tests"
```
