import { describe, it, expect, afterEach } from 'vitest';
import { NodeStatus } from '../../types.js';
import { AgentNode } from '../../nodes/agent.js';
import { TreeBuilder } from '../../builder/tree-builder.js';
import { ClaudeSDKAgent } from '../../agent/claude-sdk-agent.js';
import { createContext, collectEvents } from '../helpers.js';
import { createTreeLogger } from '../../tree-logger.js';

const LOG_FILE = 'logs/live-agent-streaming.log';

let stopLogging: (() => void) | undefined;
afterEach(() => { stopLogging?.(); stopLogging = undefined; });

describe('Agent Streaming Events', { timeout: 90_000 }, () => {
  it('emits agent:stream events during agent execution', async () => {
    const ctx = createContext();
    stopLogging = createTreeLogger(ctx.events, { filePath: LOG_FILE });

    const streamEvents = collectEvents(ctx, 'agent:stream');
    const thinkingEvents = collectEvents(ctx, 'agent:thinking');
    const responseEvents = collectEvents(ctx, 'agent:response');

    const agent = new AgentNode<unknown>({
      name: 'streamer',
      agent: new ClaudeSDKAgent({
        name: 'streamer',
        model: 'claude-haiku-4-5',
        effort: 'low',
        includePartialMessages: true,
      }),
      prompt: 'Write one sentence about trees.',
    });

    let status = await agent.tick(ctx);
    expect(status).toBe(NodeStatus.RUNNING);

    while (status === NodeStatus.RUNNING) {
      await new Promise(r => setTimeout(r, 200));
      status = await agent.tick(ctx);
    }

    expect(status).toBe(NodeStatus.SUCCESS);
    expect(responseEvents.length).toBeGreaterThanOrEqual(1);
    expect(streamEvents.length).toBeGreaterThan(0);
    for (const evt of streamEvents) {
      expect(evt.event).toBeDefined();
    }

    // agent:thinking validates the ThinkingCapable → AgentThinkingMessage path
    expect(thinkingEvents.length).toBeGreaterThan(0);
    for (const evt of thinkingEvents) {
      expect(typeof evt.thinking).toBe('string');
      expect(evt.thinking.length).toBeGreaterThan(0);
    }
  });

  it('agent:stream events flow through TreeBuilder pipelines', async () => {
    const agent = new ClaudeSDKAgent({
      name: 'pipeline-streamer',
      model: 'claude-haiku-4-5',
      effort: 'low',
      includePartialMessages: true,
    });

    const tree = new TreeBuilder('stream-pipeline')
      .agent('generate', { agent, prompt: 'Write one sentence about the ocean.' })
      .build();

    stopLogging = createTreeLogger(tree.events, { filePath: LOG_FILE });

    const streamEvents = collectEvents({ events: tree.events } as any, 'agent:stream');
    const thinkingEvents = collectEvents({ events: tree.events } as any, 'agent:thinking');

    let status = NodeStatus.RUNNING;
    while (status === NodeStatus.RUNNING) {
      status = await tree.tick();
      if (status === NodeStatus.RUNNING) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    expect(status).toBe(NodeStatus.SUCCESS);
    expect(streamEvents.length).toBeGreaterThan(0);
    expect(thinkingEvents.length).toBeGreaterThan(0);
  });
});
