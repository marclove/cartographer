# Task 12: AgentNode

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the `AgentNode` leaf node that wraps the Claude Agent SDK `query()` function in two modes: structured output and full agentic.

**Architecture:** `AgentNode` extends `BaseNode`. In `execute()`, it builds the prompt, creates the blackboard MCP server, calls `query()` with mode-appropriate options, and maps the result to a `NodeStatus`. The SDK is a real dependency — tests mock the `query()` function.

**Tech Stack:** TypeScript, @anthropic-ai/claude-agent-sdk, zod

---

### Step 1: Write failing tests

Create `src/nodes/agent.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeStatus } from '../types.js';
import type { TreeContext } from '../types.js';
import { EventEmitter } from '../core/event-emitter.js';
import { MapBlackboard } from '../core/blackboard.js';
import type { TreeEvents } from '../types.js';
import { z } from 'zod';

// We'll mock the SDK's query function
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name, _desc, _schema, handler) => handler),
}));

import { AgentNode } from './agent.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

const mockQuery = vi.mocked(query);

function createContext(): TreeContext {
  return {
    blackboard: new MapBlackboard(),
    events: new EventEmitter<TreeEvents>(),
  };
}

// Helper to create an async iterator from an array of messages
async function* mockMessages(messages: unknown[]) {
  for (const msg of messages) {
    yield msg;
  }
}

describe('AgentNode - structured mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns SUCCESS on successful structured output', async () => {
    const schema = z.object({ answer: z.string() });

    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', structured_output: { answer: 'yes' }, total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({
      name: 'classify',
      mode: 'structured',
      prompt: 'Classify this input',
      outputSchema: schema,
    });

    const ctx = createContext();
    expect(await node.tick(ctx)).toBe(NodeStatus.SUCCESS);
  });

  it('writes structured output to blackboard', async () => {
    const schema = z.object({ answer: z.string() });

    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', structured_output: { answer: 'yes' }, total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({
      name: 'classify',
      mode: 'structured',
      prompt: 'Classify this input',
      outputSchema: schema,
    });

    const ctx = createContext();
    await node.tick(ctx);

    expect(ctx.blackboard.get('classify:output')).toEqual({ answer: 'yes' });
  });

  it('uses mapResult to determine status', async () => {
    const schema = z.object({ confidence: z.number() });

    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', structured_output: { confidence: 0.3 }, total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({
      name: 'classify',
      mode: 'structured',
      prompt: 'Classify',
      outputSchema: schema,
      mapResult: (output: unknown) => {
        const data = output as { confidence: number };
        return data.confidence > 0.5 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
      },
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('returns FAILURE on SDK error', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'error_during_execution' },
    ]) as any);

    const node = new AgentNode({
      name: 'classify',
      mode: 'structured',
      prompt: 'Classify',
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('supports dynamic prompts from context', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', structured_output: {}, total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({
      name: 'dynamic',
      mode: 'structured',
      prompt: (ctx) => `Analyze: ${ctx.blackboard.get('input')}`,
    });

    const ctx = createContext();
    ctx.blackboard.set('input', 'test data');
    await node.tick(ctx);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.any(Function), // streaming input generator
      }),
    );
  });
});

describe('AgentNode - agentic mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns SUCCESS on successful agentic execution', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Working...' }] } },
      { type: 'result', subtype: 'success', result: 'Fixed the bug', total_cost_usd: 0.05 },
    ]) as any);

    const node = new AgentNode({
      name: 'fixer',
      mode: 'agentic',
      prompt: 'Fix the bug',
      allowedTools: ['Read', 'Edit'],
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.SUCCESS);
  });

  it('returns FAILURE on max_turns error', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'error_max_turns' },
    ]) as any);

    const node = new AgentNode({
      name: 'fixer',
      mode: 'agentic',
      prompt: 'Fix the bug',
      maxTurns: 5,
    });

    expect(await node.tick(createContext())).toBe(NodeStatus.FAILURE);
  });

  it('writes result text to blackboard', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'All tests pass', total_cost_usd: 0.02 },
    ]) as any);

    const node = new AgentNode({
      name: 'runner',
      mode: 'agentic',
      prompt: 'Run tests',
    });

    const ctx = createContext();
    await node.tick(ctx);

    expect(ctx.blackboard.get('runner:output')).toBe('All tests pass');
  });

  it('emits agent:response event', async () => {
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.03 },
    ]) as any);

    const node = new AgentNode({
      name: 'worker',
      mode: 'agentic',
      prompt: 'Do work',
    });

    const ctx = createContext();
    const responseSpy = vi.fn();
    ctx.events.on('agent:response', responseSpy);

    await node.tick(ctx);

    expect(responseSpy).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'done', cost: 0.03 }),
    );
  });

  it('emits agent:tool_use events for tool calls', async () => {
    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'test.ts' } },
          ],
        },
      },
      { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 },
    ]) as any);

    const node = new AgentNode({
      name: 'reader',
      mode: 'agentic',
      prompt: 'Read files',
    });

    const ctx = createContext();
    const toolSpy = vi.fn();
    ctx.events.on('agent:tool_use', toolSpy);

    await node.tick(ctx);

    expect(toolSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'Read', input: { file_path: 'test.ts' } }),
    );
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/nodes/agent.test.ts`
Expected: FAIL

### Step 3: Implement AgentNode

Create `src/nodes/agent.ts`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { BaseNode } from './base.js';
import { NodeStatus } from '../types.js';
import type { AgentNodeConfig, TreeContext } from '../types.js';
import { createBlackboardMcpServer } from '../agent/blackboard-mcp.js';

export class AgentNode extends BaseNode {
  private config: AgentNodeConfig;

  constructor(config: AgentNodeConfig) {
    super(config.name);
    this.config = config;
  }

  protected async execute(context: TreeContext): Promise<NodeStatus> {
    const prompt = typeof this.config.prompt === 'function'
      ? this.config.prompt(context)
      : this.config.prompt;

    context.events.emit('agent:prompt', {
      node: this,
      prompt,
      mode: this.config.mode,
    });

    if (this.config.mode === 'structured') {
      return this.executeStructured(prompt, context);
    } else {
      return this.executeAgentic(prompt, context);
    }
  }

  private async executeStructured(prompt: string, context: TreeContext): Promise<NodeStatus> {
    const blackboardServer = createBlackboardMcpServer(
      context.blackboard,
      this.config.blackboardNamespace,
    );

    const options: Record<string, unknown> = {
      mcpServers: { blackboard: blackboardServer },
      allowedTools: ['mcp__blackboard__*'],
      model: this.config.model,
      effort: this.config.effort ?? 'low',
      maxTurns: 1,
    };

    if (this.config.outputSchema) {
      options.outputFormat = {
        type: 'json_schema',
        schema: z.toJSONSchema(this.config.outputSchema),
      };
    }

    async function* generateMessages() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: prompt },
      };
    }

    for await (const message of query({ prompt: generateMessages(), options } as any)) {
      const msg = message as any;

      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          const output = msg.structured_output ?? msg.result;

          context.events.emit('agent:response', {
            node: this,
            result: output,
            cost: msg.total_cost_usd,
          });

          if (output !== undefined) {
            context.blackboard.set(`${this.name}:output`, output);
          }

          if (this.config.mapResult) {
            return this.config.mapResult(output, context);
          }

          return NodeStatus.SUCCESS;
        }

        return NodeStatus.FAILURE;
      }
    }

    return NodeStatus.FAILURE;
  }

  private async executeAgentic(prompt: string, context: TreeContext): Promise<NodeStatus> {
    const blackboardServer = createBlackboardMcpServer(
      context.blackboard,
      this.config.blackboardNamespace,
    );

    const mcpServers: Record<string, unknown> = {
      blackboard: blackboardServer,
      ...this.config.mcpServers,
    };

    const allowedTools = [
      ...(this.config.allowedTools ?? []),
      'mcp__blackboard__*',
    ];

    const options: Record<string, unknown> = {
      mcpServers,
      allowedTools,
      permissionMode: this.config.permissionMode ?? 'default',
      model: this.config.model,
      effort: this.config.effort ?? 'high',
      maxTurns: this.config.maxTurns,
      maxBudgetUsd: this.config.maxBudgetUsd,
      systemPrompt: this.config.systemPrompt,
    };

    async function* generateMessages() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: prompt },
      };
    }

    for await (const message of query({ prompt: generateMessages(), options } as any)) {
      const msg = message as any;

      // Emit tool use events for observability
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            context.events.emit('agent:tool_use', {
              node: this,
              tool: block.name,
              input: block.input,
            });
          }
        }
      }

      if (msg.type === 'result') {
        const result = msg.result;
        const cost = msg.total_cost_usd;

        context.events.emit('agent:response', {
          node: this,
          result,
          cost,
        });

        if (result !== undefined) {
          context.blackboard.set(`${this.name}:output`, result);
        }

        return msg.subtype === 'success' ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
      }
    }

    return NodeStatus.FAILURE;
  }
}
```

### Step 4: Run test to verify it passes

Run: `npx vitest run src/nodes/agent.test.ts`
Expected: PASS (all 10 tests)

### Step 5: Commit

```bash
git add src/nodes/agent.ts src/nodes/agent.test.ts
git commit -m "feat: implement AgentNode with structured and agentic execution modes"
```
