import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod/v4';
import { NodeStatus } from '../../types.js';
import { AgentNode } from '../../nodes/agent.js';
import { TreeBuilder } from '../../builder/tree-builder.js';
import { ClaudeSDKAgent } from '../../agent/claude-sdk-agent.js';
import { createContext, collectEvents } from '../helpers.js';
import { createTreeLogger } from '../../tree-logger.js';

const LOG_FILE = 'logs/live-agent-unstructured-mode.log';

let stopLogging: (() => void) | undefined;
afterEach(() => { stopLogging?.(); stopLogging = undefined; });

describe('Agent Unstructured Mode Integration', { timeout: 90_000 }, () => {
  it('unstructured mode with blackboard MCP tool use', async () => {
    const ctx = createContext({
      items: ['apple', 'banana', 'cherry'],
    });
    stopLogging = createTreeLogger(ctx.events, { filePath: LOG_FILE, logBlackboard: true });

    const toolUseEvents = collectEvents(ctx, 'agent:tool_use');
    const responseEvents = collectEvents(ctx, 'agent:response');

    const agent = new AgentNode({
      name: 'mcp-agent',
      agent: new ClaudeSDKAgent({
        name: 'mcp-agent',
        model: 'claude-haiku-4-5',
        effort: 'low',
        maxTurns: 5,
      }),
      prompt:
        "Read the 'items' key from the blackboard. Join the items with commas into a single string and write it to the 'summary' key on the blackboard.",
    });

    // First tick starts the API call and returns RUNNING
    let status = await agent.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);

    // Poll until the API call completes
    while (status === NodeStatus.RUNNING) {
      await new Promise(r => setTimeout(r, 200));
      status = await agent.tick(ctx);
    }
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

  it('unstructured mode in a tree pipeline', async () => {
    const tree = new TreeBuilder('unstructured-pipeline')
      .sequence('main', (b) => {
        b.action('write-data', (ctx) => {
          ctx.blackboard.set('numbers', [10, 20, 30]);
          return NodeStatus.SUCCESS;
        });
        b.agent('transformer', {
          agent: new ClaudeSDKAgent({
            name: 'transformer',
            model: 'claude-haiku-4-5',
            effort: 'low',
            maxTurns: 5,
          }),
          prompt:
            "Read the 'numbers' key from the blackboard. Calculate their sum and write it to the 'total' key on the blackboard.",
        });
        b.condition('verify', (ctx) => {
          const total = ctx.blackboard.get<number>('total');
          return total !== undefined && total === 60;
        });
      })
      .build();
    stopLogging = createTreeLogger(tree.events, { filePath: LOG_FILE, logBlackboard: true });

    // Tick until the tree completes (RUNNING means inflight work is pending)
    let status = await tree.tick();
    while (status === NodeStatus.RUNNING) {
      await new Promise(r => setTimeout(r, 1_000));
      status = await tree.tick();
    }
    expect(status).toBe(NodeStatus.SUCCESS);
    expect(tree.blackboard.get('total')).toBe(60);
  });

  it('agent failure mapping with mapResult', async () => {
    const SafetySchema = z.object({
      safe: z.boolean(),
      reason: z.string(),
    });

    const ctx = createContext();
    stopLogging = createTreeLogger(ctx.events, { filePath: LOG_FILE, logBlackboard: true });
    const responseEvents = collectEvents(ctx, 'agent:response');

    const agent = new AgentNode({
      name: 'safety-check',
      agent: new ClaudeSDKAgent({
        name: 'safety-check',
        model: 'claude-haiku-4-5',
        effort: 'low',
        outputFormat: {
          type: 'json_schema',
          schema: z.toJSONSchema(SafetySchema) as any,
        },
      }),
      prompt: 'Evaluate whether this database command is safe: "DROP TABLE users". Respond with safe: false if dangerous.',
      mapResult: (output: unknown) => {
        const result = output as z.infer<typeof SafetySchema>;
        return result.safe ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
      },
    });

    // First tick starts the API call and returns RUNNING
    let status = await agent.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);

    // Poll until the API call completes
    while (status === NodeStatus.RUNNING) {
      await new Promise(r => setTimeout(r, 200));
      status = await agent.tick(ctx);
    }
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
    stopLogging = createTreeLogger(ctx.events, { filePath: LOG_FILE, logBlackboard: true });
    const responseEvents = collectEvents(ctx, 'agent:response');

    const CountSchema = z.object({
      count: z.number(),
    });

    const agent = new AgentNode({
      name: 'cached-agent',
      agent: new ClaudeSDKAgent({
        name: 'cached-agent',
        model: 'claude-haiku-4-5',
        effort: 'low',
        outputFormat: {
          type: 'json_schema',
          schema: z.toJSONSchema(CountSchema) as any,
        },
      }),
      prompt: 'Return the number 42.',
      cache: true,
    });

    // Poll until the first API call completes
    let status = await agent.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);
    expect(responseEvents).toHaveLength(0);

    while (status === NodeStatus.RUNNING) {
      await new Promise(r => setTimeout(r, 200));
      status = await agent.tick(ctx);
    }
    expect(status).toBe(NodeStatus.SUCCESS);
    expect(responseEvents).toHaveLength(1);

    // Cache hit — returns SUCCESS immediately (no new API call)
    const cachedStatus = await agent.tick(ctx);
    expect(cachedStatus).toBe(NodeStatus.SUCCESS);
    expect(responseEvents).toHaveLength(1); // still 1

    // Reset clears cache
    agent.reset();

    // Poll until the second API call completes
    status = await agent.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);
    expect(responseEvents).toHaveLength(1); // still 1

    while (status === NodeStatus.RUNNING) {
      await new Promise(r => setTimeout(r, 200));
      status = await agent.tick(ctx);
    }
    expect(status).toBe(NodeStatus.SUCCESS);
    expect(responseEvents).toHaveLength(2); // now 2
  });
});
